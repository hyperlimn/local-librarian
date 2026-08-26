import { lstat } from "node:fs/promises";
import * as path from "node:path";

import type { CanonicalAbsolutePath } from "../domain/index.js";
import {
  createFilesystemRootIdentity,
  type ApprovedEnrolledRoot,
  type RootEnrollmentStore,
  type VolumeIdentityProvider,
} from "../enrollment/index.js";
import type {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
  SafetyAuthorization,
} from "../safety/index.js";

export type TransferRootValidationCode =
  | "ROOT_NOT_ENROLLED"
  | "ROOT_NOT_APPROVED"
  | "ROOT_IDENTITY_MISMATCH"
  | "ROOT_ROLE_INVALID"
  | "WRITES_DISABLED"
  | "SOURCE_RETIREMENT_DISABLED"
  | "ROOT_BOUNDARY_DENIED";

export class TransferRootValidationError extends Error {
  public constructor(public readonly code: TransferRootValidationCode, message: string) {
    super(message);
    this.name = "TransferRootValidationError";
  }
}

/** Validates either enrolled-root role without assuming drive-letter paths. */
export class TransferRootGuard {
  readonly #paths: path.PlatformPath;

  public constructor(
    private readonly enrollments: RootEnrollmentStore,
    private readonly canonicalizer: ReadOnlyCanonicalPathResolver,
    private readonly volumes: VolumeIdentityProvider,
    private readonly resolver: ReadOnlyRootPathResolver,
    private readonly boundary: PathBoundary,
    platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix",
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  public async validate(
    rootId: string,
    expectedIdentityKey: string,
    input: {
      readonly role?: "library" | "ingest-source";
      readonly requireWrite?: boolean;
      readonly requireSourceRetirement?: boolean;
    } = {},
  ): Promise<ApprovedEnrolledRoot> {
    const root = await this.enrollments.get(rootId as ApprovedEnrolledRoot["id"]);
    if (root === undefined) {
      throw new TransferRootValidationError("ROOT_NOT_ENROLLED", "The filesystem root is not enrolled.");
    }
    if (root.approval.status !== "approved") {
      throw new TransferRootValidationError("ROOT_NOT_APPROVED", "The filesystem root is not approved.");
    }
    const role = "controlDirectory" in root.policy ? "library" : "ingest-source";
    if (input.role !== undefined && role !== input.role) {
      throw new TransferRootValidationError("ROOT_ROLE_INVALID", `The selected root is not an approved ${input.role}.`);
    }
    if (root.identity.key !== expectedIdentityKey) {
      throw new TransferRootValidationError("ROOT_IDENTITY_MISMATCH", "The persisted root identity is stale.");
    }
    if (input.requireWrite === true && !root.policy.allowWrites) {
      throw new TransferRootValidationError("WRITES_DISABLED", "Writes are not explicitly approved for this root.");
    }
    if (
      input.requireSourceRetirement === true &&
      (!("allowSourceRetirement" in root.policy) || !root.policy.allowSourceRetirement)
    ) {
      throw new TransferRootValidationError(
        "SOURCE_RETIREMENT_DISABLED",
        "Source retirement is not explicitly approved for this ingest source.",
      );
    }
    try {
      const inspection = await this.canonicalizer.inspectExisting(root.canonicalPath);
      this.canonicalizer.assertDirectory(inspection);
      if (inspection.reparsePoints.length > 0) {
        throw new TransferRootValidationError(
          "ROOT_BOUNDARY_DENIED",
          "The enrolled root now traverses a symlink, junction, or reparse point.",
        );
      }
      const volume = await this.volumes.identify(inspection);
      const current = createFilesystemRootIdentity(
        inspection,
        volume,
        this.#paths === path.win32 ? "win32" : "posix",
      );
      if (current.key !== root.identity.key || volume.key !== root.identity.volume.key) {
        throw new TransferRootValidationError(
          "ROOT_IDENTITY_MISMATCH",
          "The mounted filesystem no longer matches the approved root.",
        );
      }
      return root as ApprovedEnrolledRoot;
    } catch (error) {
      if (error instanceof TransferRootValidationError) throw error;
      throw new TransferRootValidationError(
        "ROOT_BOUNDARY_DENIED",
        error instanceof Error ? error.message : "The filesystem root could not be validated.",
      );
    }
  }

  public async resolveExisting(
    root: ApprovedEnrolledRoot,
    relativePath: string,
  ): Promise<SafetyAuthorization> {
    const decision = await this.resolver.resolveExisting(root, relativePath);
    if (!decision.allowed) {
      throw new TransferRootValidationError("ROOT_BOUNDARY_DENIED", decision.reason);
    }
    return decision.authorization;
  }

  public async authorizeExistingWrite(
    root: ApprovedEnrolledRoot,
    relativePath: string,
  ): Promise<SafetyAuthorization> {
    const read = await this.resolveExisting(root, relativePath);
    const decision = this.boundary.authorizeCanonicalPath(root, read.canonicalPath, "write");
    if (!decision.allowed) {
      throw new TransferRootValidationError("ROOT_BOUNDARY_DENIED", decision.reason);
    }
    return decision.authorization;
  }

  /** Authorizes a missing destination only after checking every existing ancestor. */
  public async authorizeProspectiveWrite(
    root: ApprovedEnrolledRoot,
    relativePath: string,
  ): Promise<SafetyAuthorization> {
    const lexical = this.boundary.resolveRelativePath(root, relativePath);
    if (!lexical.resolved) {
      throw new TransferRootValidationError("ROOT_BOUNDARY_DENIED", lexical.reason);
    }
    let ancestor = lexical.absolutePath;
    for (;;) {
      try {
        await lstat(ancestor);
        break;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        const parent = this.#paths.dirname(ancestor);
        if (parent === ancestor) {
          throw new TransferRootValidationError("ROOT_BOUNDARY_DENIED", "No safe destination ancestor exists.");
        }
        ancestor = parent;
      }
    }
    const inspection = await this.canonicalizer.inspectExisting(ancestor);
    if (
      inspection.entryKind !== "directory" ||
      inspection.reparsePoints.length > 0 ||
      inspection.deviceId !== root.identity.volume.deviceId
    ) {
      throw new TransferRootValidationError(
        "ROOT_BOUNDARY_DENIED",
        "The destination ancestor failed its canonical filesystem boundary check.",
      );
    }
    const canonicalCandidate = await this.canonicalizer.canonicalizeProspective(
      lexical.absolutePath,
    ) as CanonicalAbsolutePath;
    const decision = this.boundary.authorizeCanonicalPath(root, canonicalCandidate, "write");
    if (!decision.allowed) {
      throw new TransferRootValidationError("ROOT_BOUNDARY_DENIED", decision.reason);
    }
    return decision.authorization;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
