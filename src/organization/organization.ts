import type {
  InventoryScanId,
  JobId,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";

export type FileMutationMode = "read-only" | "live";

export interface FileMutationModeState {
  readonly mode: FileMutationMode;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export type OrganizationStrategy =
  | "category"
  | "category-and-year"
  | "year-and-month";

export type OrganizationScope = "top-level" | "all-files";
export type OrganizationCollisionPolicy = "skip" | "rename-with-suffix";
export type OrganizationPhilosophy = "conservative" | "balanced" | "deep";

export interface OrganizationPlanOptions {
  readonly strategy: OrganizationStrategy;
  readonly philosophy: OrganizationPhilosophy;
  readonly scope: OrganizationScope;
  readonly targetDirectory: RootRelativePath;
  readonly collisionPolicy: OrganizationCollisionPolicy;
  readonly includeHidden: boolean;
  readonly maximumOperations: number;
}

export interface OrganizationPlanCounts {
  readonly scannedFiles: number;
  readonly eligibleFiles: number;
  readonly plannedMoves: number;
  readonly representedBytes: number;
  readonly preservedByScope: number;
  readonly alreadyOrganized: number;
  readonly hiddenExcluded: number;
  readonly conflictsSkipped: number;
  readonly limitedOut: number;
  readonly preservedCoherentGroups: number;
  readonly needsReviewExcluded: number;
  readonly byCategory: Readonly<Record<string, number>>;
}

export type OrganizationPlanStatus = "ready" | "archived";

export interface OrganizationPlan {
  readonly id: string;
  readonly rootId: LibraryRootId;
  readonly rootIdentityKey: string;
  readonly scanId: InventoryScanId;
  readonly status: OrganizationPlanStatus;
  readonly options: OrganizationPlanOptions;
  readonly counts: OrganizationPlanCounts;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface OrganizationOperationExpectedFacts {
  readonly byteLength: number;
  readonly modifiedAt?: string;
  readonly deviceId?: string;
  readonly filesystemRecordId?: string;
}

export interface OrganizationOperation {
  readonly id: string;
  readonly planId: string;
  readonly ordinal: number;
  readonly sourceRelativePath: RootRelativePath;
  readonly destinationRelativePath: RootRelativePath;
  readonly category: string;
  readonly rationale: string;
  readonly expected: OrganizationOperationExpectedFacts;
}

export interface OrganizationOperationPage {
  readonly items: readonly OrganizationOperation[];
  readonly nextCursor?: string;
}

export type OrganizationRunMode =
  | "simulation"
  | "live"
  | "rollback-simulation"
  | "rollback-live";

export type OrganizationRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface OrganizationRunCounts {
  readonly total: number;
  readonly processed: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface OrganizationRun {
  readonly id: string;
  readonly planId: string;
  readonly sourceRunId?: string;
  readonly jobId?: JobId;
  readonly mode: OrganizationRunMode;
  readonly status: OrganizationRunStatus;
  readonly approvedBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly counts: OrganizationRunCounts;
}

export type OrganizationRunItemOutcome =
  | "simulated"
  | "moved"
  | "already-completed"
  | "would-rollback"
  | "rolled-back"
  | "already-rolled-back"
  | "skipped"
  | "failed";

export interface OrganizationRunItem {
  readonly runId: string;
  readonly operationId: string;
  readonly outcome: OrganizationRunItemOutcome;
  readonly message: string;
  readonly completedAt: string;
}

export interface OrganizationRunItemPage {
  readonly items: readonly (OrganizationRunItem & {
    readonly operation: OrganizationOperation;
  })[];
  readonly nextCursor?: string;
}

export interface OrganizationPlanPage {
  readonly items: readonly OrganizationPlan[];
  readonly nextCursor?: string;
}

export interface OrganizationRunPage {
  readonly items: readonly OrganizationRun[];
  readonly nextCursor?: string;
}

export interface OrganizationAuditEvent {
  readonly sequence: number;
  readonly id: string;
  readonly event: string;
  readonly occurredAt: string;
  readonly actor: string;
  readonly correlationId: string;
  readonly previousHash?: string;
  readonly entryHash: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface OrganizationAuditPage {
  readonly items: readonly OrganizationAuditEvent[];
  readonly nextCursor?: string;
}

export interface OrganizationAuditIntegrity {
  readonly valid: boolean;
  readonly entriesChecked: number;
  readonly firstInvalidSequence?: number;
  readonly reason?: string;
}
