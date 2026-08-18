import type {
  CanonicalAbsolutePath,
  FilesystemBoundaryRoot,
  FilesystemRootIdentity,
  FilesystemRootApproval,
  ApprovedFilesystemRootApproval,
  IngestSourceId,
  RootBoundaryPolicy,
  RootRelativePath,
} from "../domain/index.js";

export type IngestSourceKind =
  | "folder"
  | "drive"
  | "sd-card"
  | "drop-directory";

export interface IngestSourcePolicy extends RootBoundaryPolicy {
  /** Source retirement requires this and allowWrites to both be true. */
  readonly allowSourceRetirement: boolean;
  readonly removableMedia: boolean;
}

/** An ingest source is independently approved; it is never an implicit root. */
export interface IngestSource extends FilesystemBoundaryRoot {
  readonly id: IngestSourceId;
  readonly kind: IngestSourceKind;
  readonly displayName: string;
  readonly displayPath: string;
  readonly canonicalPath: CanonicalAbsolutePath;
  readonly identity: FilesystemRootIdentity;
  readonly approval: FilesystemRootApproval;
  readonly policy: IngestSourcePolicy;
  readonly volumeIdentity?: string;
  readonly createdAt: string;
}

export interface IngestSourceLocation {
  readonly ingestSourceId: IngestSourceId;
  readonly relativePath: RootRelativePath;
}

export type ApprovedIngestSource = IngestSource & {
  readonly approval: ApprovedFilesystemRootApproval;
};

export type SourceRetirementDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Policy check only; path authorization is still separately required. */
export function evaluateSourceRetirement(
  source: IngestSource,
): SourceRetirementDecision {
  if (source.approval.status !== "approved") {
    return { allowed: false, reason: "The ingest source is not approved." };
  }
  if (!source.policy.allowWrites) {
    return { allowed: false, reason: "Writes to the ingest source are disabled." };
  }
  if (!source.policy.allowSourceRetirement) {
    return {
      allowed: false,
      reason: "Source retirement was not explicitly approved.",
    };
  }
  return { allowed: true };
}
