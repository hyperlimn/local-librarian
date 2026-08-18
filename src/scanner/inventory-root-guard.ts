import * as path from "node:path";

import type {
  ApprovedLibraryRoot,
  CanonicalAbsolutePath,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";
import type { RootEnrollmentStore } from "../enrollment/index.js";
import {
  createFilesystemRootIdentity,
  type VolumeIdentityProvider,
} from "../enrollment/index.js";
import type {
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
} from "../safety/index.js";

export type InventoryRootValidationCode =
  | "ROOT_NOT_ENROLLED"
  | "ROOT_ROLE_INVALID"
  | "ROOT_NOT_APPROVED"
  | "ROOT_IDENTITY_MISMATCH"
  | "ROOT_CANONICALIZATION_FAILED"
  | "ROOT_BOUNDARY_DENIED";

export class InventoryRootValidationError extends Error {
  public constructor(
    public readonly code: InventoryRootValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "InventoryRootValidationError";
  }
}

export class InventoryRootGuard {
  readonly #paths: path.PlatformPath;

  public constructor(
    private readonly enrollments: RootEnrollmentStore,
    private readonly canonicalizer: ReadOnlyCanonicalPathResolver,
    private readonly volumes: VolumeIdentityProvider,
    private readonly rootResolver: ReadOnlyRootPathResolver,
    platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix",
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  /** Full enrollment, canonical path, volume, and durable identity validation. */
  public async validateForScan(
    rootId: LibraryRootId,
    expectedIdentityKey: string,
  ): Promise<ApprovedLibraryRoot> {
    const root = await this.loadApprovedLibrary(rootId, expectedIdentityKey);
    try {
      const inspection = await this.canonicalizer.inspectExisting(root.canonicalPath);
      this.canonicalizer.assertDirectory(inspection);
      if (inspection.reparsePoints.length > 0) {
        throw new InventoryRootValidationError(
          "ROOT_BOUNDARY_DENIED",
          "The enrolled root now traverses a symlink, junction, or reparse point.",
        );
      }
      if (!samePath(inspection.canonicalPath, root.canonicalPath, this.#paths)) {
        throw new InventoryRootValidationError(
          "ROOT_IDENTITY_MISMATCH",
          "The enrolled root canonical path changed after approval.",
        );
      }
      const volume = await this.volumes.identify(inspection);
      const identity = createFilesystemRootIdentity(
        inspection,
        volume,
        this.#paths === path.win32 ? "win32" : "posix",
      );
      if (
        identity.key !== root.identity.key ||
        identity.key !== expectedIdentityKey ||
        volume.key !== root.identity.volume.key
      ) {
        throw new InventoryRootValidationError(
          "ROOT_IDENTITY_MISMATCH",
          "The mounted filesystem identity no longer matches enrollment.",
        );
      }
      return root;
    } catch (error) {
      if (error instanceof InventoryRootValidationError) throw error;
      throw new InventoryRootValidationError(
        "ROOT_CANONICALIZATION_FAILED",
        error instanceof Error
          ? `Unable to validate the enrolled root: ${error.message}`
          : "Unable to validate the enrolled root.",
      );
    }
  }

  /** Cheap durable approval check used at every batch boundary. */
  public loadApprovedLibrary(
    rootId: LibraryRootId,
    expectedIdentityKey: string,
  ): Promise<ApprovedLibraryRoot> {
    return this.loadApprovedLibraryInternal(rootId, expectedIdentityKey);
  }

  public async resolveDirectory(
    root: ApprovedLibraryRoot,
    relativePath: RootRelativePath,
  ): Promise<CanonicalAbsolutePath> {
    await this.loadApprovedLibrary(root.id, root.identity.key);
    if (relativePath === "") {
      try {
        const inspection = await this.canonicalizer.inspectExisting(root.canonicalPath);
        if (
          inspection.entryKind !== "directory" ||
          inspection.reparsePoints.length > 0 ||
          inspection.deviceId !== root.identity.volume.deviceId ||
          !samePath(inspection.canonicalPath, root.canonicalPath, this.#paths)
        ) {
          throw new InventoryRootValidationError(
            "ROOT_BOUNDARY_DENIED",
            "The root failed its current canonical boundary check.",
          );
        }
        return inspection.canonicalPath;
      } catch (error) {
        if (error instanceof InventoryRootValidationError) throw error;
        throw new InventoryRootValidationError(
          "ROOT_BOUNDARY_DENIED",
          "The root could not be safely resolved for traversal.",
        );
      }
    }

    const decision = await this.rootResolver.resolveExisting(root, relativePath);
    if (!decision.allowed) {
      throw new InventoryRootValidationError(
        "ROOT_BOUNDARY_DENIED",
        decision.reason,
      );
    }
    return decision.authorization.canonicalPath;
  }

  private async loadApprovedLibraryInternal(
    rootId: LibraryRootId,
    expectedIdentityKey: string,
  ): Promise<ApprovedLibraryRoot> {
    const root = await this.enrollments.get(rootId);
    if (root === undefined) {
      throw new InventoryRootValidationError(
        "ROOT_NOT_ENROLLED",
        `Library root ${rootId} is not enrolled.`,
      );
    }
    if (!("controlDirectory" in root.policy)) {
      throw new InventoryRootValidationError(
        "ROOT_ROLE_INVALID",
        `Enrolled root ${rootId} is an ingest source, not a library root.`,
      );
    }
    if (root.approval.status !== "approved") {
      throw new InventoryRootValidationError(
        "ROOT_NOT_APPROVED",
        `Library root ${rootId} is not currently approved.`,
      );
    }
    if (root.identity.key !== expectedIdentityKey) {
      throw new InventoryRootValidationError(
        "ROOT_IDENTITY_MISMATCH",
        "The job's enrolled-root identity binding is stale.",
      );
    }
    return root as ApprovedLibraryRoot;
  }
}

function samePath(
  left: string,
  right: string,
  paths: path.PlatformPath,
): boolean {
  const normalizedLeft = paths.normalize(left);
  const normalizedRight = paths.normalize(right);
  return paths === path.win32
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

