import { createHash, randomUUID } from "node:crypto";

import type {
  ApprovedLibraryRoot,
  IngestSourceId,
  LibraryRoot,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";
import type { ApprovedIngestSource } from "../ingest/index.js";
import { ReadOnlyCanonicalPathResolver } from "../safety/index.js";
import type {
  EnrolledRootId,
  EnrolledRootListQuery,
  RootEnrollmentProposal,
  RootProposalInput,
} from "./enrollment.js";
import type {
  EnrolledRoot,
  ApprovedEnrolledRoot,
  RootEnrollmentStore,
} from "./enrollment-store.js";
import {
  createFilesystemRootIdentity,
  type VolumeIdentityProvider,
} from "./volume-identity.js";

export class RootEnrollmentService {
  readonly #proposals = new Map<string, RootEnrollmentProposal>();

  public constructor(
    private readonly canonicalizer: ReadOnlyCanonicalPathResolver,
    private readonly volumes: VolumeIdentityProvider,
    private readonly store: RootEnrollmentStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async propose(
    input: RootProposalInput,
  ): Promise<RootEnrollmentProposal> {
    if (input.displayName.trim().length === 0) {
      throw new Error("A display name is required.");
    }
    const inspection = await this.canonicalizer.inspectExisting(input.path);
    this.canonicalizer.assertDirectory(inspection);
    if (inspection.reparsePoints.length > 0) {
      throw new Error(
        "An enrollment path may not traverse a symlink, junction, or reparse point.",
      );
    }

    const volume = await this.volumes.identify(inspection);
    const identity = createFilesystemRootIdentity(inspection, volume);
    const proposalId = randomUUID();
    const warnings = [
      ...(volume.stability === "best-effort"
        ? [
            "A stable volume GUID was unavailable; recognition after remount is best-effort.",
          ]
        : []),
      "Write access is disabled initially and requires a separate explicit approval.",
    ];
    const base = {
      proposalId,
      displayName: input.displayName,
      displayPath: input.path,
      canonicalPath: inspection.canonicalPath,
      identity,
      warnings,
      approvalRequired: true as const,
      proposedAt: this.now(),
    };
    const proposal: RootEnrollmentProposal =
      input.role === "library"
        ? { ...base, role: "library" }
        : {
            ...base,
            role: "ingest-source",
            ingestSourceKind: input.ingestSourceKind,
          };

    this.#proposals.set(proposalId, proposal);
    return proposal;
  }

  public async approve(
    proposalId: string,
    approvedBy: string,
  ): Promise<ApprovedEnrolledRoot> {
    if (approvedBy.trim().length === 0) {
      throw new Error("An approving actor is required.");
    }
    const proposal = this.#proposals.get(proposalId);
    if (proposal === undefined) {
      throw new Error("The enrollment proposal is unknown or has expired.");
    }

    const inspection = await this.canonicalizer.inspectExisting(
      proposal.displayPath,
    );
    this.canonicalizer.assertDirectory(inspection);
    if (inspection.reparsePoints.length > 0) {
      throw new Error("The proposed path now traverses a reparse point.");
    }
    const volume = await this.volumes.identify(inspection);
    const identity = createFilesystemRootIdentity(inspection, volume);
    if (identity.key !== proposal.identity.key) {
      throw new Error(
        "The filesystem root changed after inspection; create a new proposal.",
      );
    }

    const approvedAt = this.now();
    const rootId = createEnrolledRootId(proposal.role, identity.key);
    const existing = await this.store.get(rootId);
    const createdAt = existing?.createdAt ?? approvedAt;
    const approval = { status: "approved" as const, approvedAt, approvedBy };
    const root: ApprovedEnrolledRoot =
      proposal.role === "library"
        ? ({
            id: rootId as LibraryRootId,
            displayName: proposal.displayName,
            displayPath: proposal.displayPath,
            canonicalPath: inspection.canonicalPath,
            identity,
            approval,
            policy: {
              allowWrites: false,
              followSymbolicLinks: false,
              stayOnFileSystem: true,
              controlDirectory: ".local-librarian" as RootRelativePath,
              quarantineDirectory:
                ".local-librarian/quarantine" as RootRelativePath,
              ignoredPaths: [".local-librarian" as RootRelativePath],
            },
            createdAt,
          } satisfies ApprovedLibraryRoot)
        : ({
            id: rootId as IngestSourceId,
            kind: proposal.ingestSourceKind,
            displayName: proposal.displayName,
            displayPath: proposal.displayPath,
            canonicalPath: inspection.canonicalPath,
            identity,
            approval,
            policy: {
              allowWrites: false,
              allowSourceRetirement: false,
              followSymbolicLinks: false,
              stayOnFileSystem: true,
              ignoredPaths: [],
              removableMedia: proposal.ingestSourceKind === "sd-card",
            },
            volumeIdentity: identity.volume.key,
            createdAt,
          } satisfies ApprovedIngestSource);

    await this.store.saveApproved(root);
    this.#proposals.delete(proposalId);
    return root;
  }

  public list(
    query: EnrolledRootListQuery = {},
  ): Promise<readonly EnrolledRoot[]> {
    return this.store.list(query);
  }

  public get(id: EnrolledRootId): Promise<EnrolledRoot | undefined> {
    return this.store.get(id);
  }

  /** Separately approves or revokes write access without changing root identity. */
  public async setLibraryWriteAccess(
    id: LibraryRootId,
    allowWrites: boolean,
    approvedBy: string,
  ): Promise<ApprovedLibraryRoot> {
    if (approvedBy.trim().length === 0) {
      throw new Error("An approving actor is required.");
    }
    const existing = await this.store.get(id);
    if (existing === undefined || !("controlDirectory" in existing.policy)) {
      throw new Error("The library root is not enrolled.");
    }
    const library = existing as LibraryRoot;
    if (library.approval.status !== "approved") {
      throw new Error("Write access cannot be changed for a revoked library root.");
    }
    const updated: ApprovedLibraryRoot = {
      ...library,
      approval: {
        status: "approved",
        approvedAt: this.now(),
        approvedBy: approvedBy.trim(),
      },
      policy: { ...library.policy, allowWrites },
    };
    await this.store.saveApproved(updated);
    return updated;
  }

  /** Independently gates ingest-source writes and retirement; both default off. */
  public async setIngestSourceRetirementAccess(
    id: IngestSourceId,
    allowWrites: boolean,
    allowSourceRetirement: boolean,
    approvedBy: string,
  ): Promise<ApprovedIngestSource> {
    if (approvedBy.trim().length === 0) throw new Error("An approving actor is required.");
    if (allowSourceRetirement && !allowWrites) {
      throw new Error("Source retirement cannot be enabled while source writes are disabled.");
    }
    const existing = await this.store.get(id);
    if (
      existing === undefined || "controlDirectory" in existing.policy ||
      existing.approval.status !== "approved"
    ) {
      throw new Error("The ingest source is not approved.");
    }
    const source = existing as ApprovedIngestSource;
    const updated: ApprovedIngestSource = {
      ...source,
      approval: {
        status: "approved",
        approvedAt: this.now(),
        approvedBy: approvedBy.trim(),
      },
      policy: { ...source.policy, allowWrites, allowSourceRetirement },
    };
    await this.store.saveApproved(updated);
    return updated;
  }

  public async revoke(
    id: EnrolledRootId,
    reason: string,
  ): Promise<EnrolledRoot> {
    if (reason.trim().length === 0) {
      throw new Error("A revocation reason is required.");
    }
    return this.store.revoke(id, reason, this.now());
  }
}

function createEnrolledRootId(
  role: "library" | "ingest-source",
  identityKey: string,
): EnrolledRootId {
  const digest = createHash("sha256")
    .update("local-librarian-enrollment-v1\0", "utf8")
    .update(role, "utf8")
    .update("\0", "utf8")
    .update(identityKey, "utf8")
    .digest("hex");
  return `enrolled-root-v1:${role}:${digest}` as EnrolledRootId;
}
