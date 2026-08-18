import type {
  ContentId,
  LibraryRootId,
  OperationId,
  PlanId,
  RootRelativePath,
} from "./ids.js";

export interface LibraryLocation {
  readonly libraryRootId: LibraryRootId;
  readonly relativePath: RootRelativePath;
}

export interface OperationPreconditions {
  readonly expectedContentId?: ContentId;
  readonly expectedByteLength?: number;
  readonly destinationMustNotExist: boolean;
  readonly sourceMustExist: boolean;
}

interface ProposedOperationBase {
  readonly id: OperationId;
  readonly planId: PlanId;
  readonly rationale: string;
  readonly confidence: number;
  readonly preconditions: OperationPreconditions;
  readonly proposedAt: string;
}

export interface SameFileSystemRelocateOperation extends ProposedOperationBase {
  readonly kind: "same-filesystem-relocate";
  readonly source: LibraryLocation;
  readonly destination: LibraryLocation;
  readonly sameFileSystemRequired: true;
}

export interface CopyFileOperation extends ProposedOperationBase {
  readonly kind: "copy-file";
  readonly source: LibraryLocation;
  readonly destination: LibraryLocation;
}

export interface VerifyContentIdentityOperation extends ProposedOperationBase {
  readonly kind: "verify-content-identity";
  readonly target: LibraryLocation;
  readonly expectedContentId: ContentId;
}

export interface QuarantineOperation extends ProposedOperationBase {
  readonly kind: "quarantine";
  readonly source: LibraryLocation;
  readonly quarantineDestination: LibraryLocation;
  readonly reason: string;
}

export interface RestoreOperation extends ProposedOperationBase {
  readonly kind: "restore";
  readonly quarantineSource: LibraryLocation;
  readonly destination: LibraryLocation;
}

export interface CreateDirectoryOperation extends ProposedOperationBase {
  readonly kind: "create-directory";
  readonly destination: LibraryLocation;
}

/** Permanent deletion is intentionally absent from this union. */
export type ProposedOperation =
  | SameFileSystemRelocateOperation
  | CopyFileOperation
  | VerifyContentIdentityOperation
  | QuarantineOperation
  | RestoreOperation
  | CreateDirectoryOperation;

/** A safe cross-filesystem relocation is always expanded to these operations. */
export interface CrossFileSystemRelocationSequence {
  readonly kind: "cross-filesystem-relocation-sequence";
  readonly copy: CopyFileOperation;
  readonly verify: VerifyContentIdentityOperation;
  readonly quarantineSource: QuarantineOperation;
}

export type PlanStatus =
  | "draft"
  | "ready-for-review"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed"
  | "rolled-back";

export interface OperationPlan {
  readonly id: PlanId;
  readonly libraryRootIds: readonly LibraryRootId[];
  readonly status: PlanStatus;
  readonly operations: readonly ProposedOperation[];
  readonly createdAt: string;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
}
