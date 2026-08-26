import type {
  JobEventId,
  JobId,
  JsonObject,
  WorkerId,
} from "../domain/index.js";

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type KnownJobKind =
  | "diagnostic.count"
  | "inventory.scan"
  | "organization.execute"
  | "organization.rollback"
  | "content.hash"
  | "duplicates.detect"
  | "media.analyze"
  | "relationships.analyze"
  | "scans.reconcile"
  | "thumbnail.generate"
  | "transfer.execute"
  | "transfer.verify"
  | "ingest.analyze"
  | "ingest.transfer"
  | "quarantine.execute"
  | "quarantine.restore";

/** Known kinds get autocomplete while plugins may register namespaced kinds. */
export type JobKind = KnownJobKind | (string & {});
export type JobRecoveryMode = "restart" | "resume-from-checkpoint";

export interface JobDefinition {
  readonly kind: JobKind;
  readonly recoveryMode: JobRecoveryMode;
  validatePayload(payload: JsonObject): void;
}

export interface JobControlPolicy {
  readonly pauseMode: "checkpoint" | "not-supported";
  readonly cancellationMode: "cooperative";
  readonly maximumAttempts: number;
  readonly leaseDurationMilliseconds: number;
}

export interface JobSubmission {
  readonly kind: JobKind;
  readonly payload: JsonObject;
  readonly priority: number;
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly controlPolicy: JobControlPolicy;
}

/** Returned only after the submission has been durably committed. */
export interface JobSubmissionReceipt {
  readonly jobId: JobId;
  readonly status: JobStatus;
  readonly submittedAt: string;
  readonly deduplicatedSubmission: boolean;
}

export interface JobProgress {
  readonly phase: string;
  readonly completedUnits: number;
  readonly totalUnits?: number;
  readonly unit: "items" | "bytes" | "steps" | "unknown";
  readonly percent?: number;
  readonly message?: string;
  /** Kind-specific counters; inventory scans omit percent because totals are unknown. */
  readonly metrics?: JsonObject;
  readonly updatedAt: string;
}

export interface StructuredJobError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: JsonObject;
  readonly occurredAt: string;
}

export interface JobArtifact {
  readonly kind: "ingest-receipt" | "manifest" | "catalog-query" | "other";
  readonly id: string;
  readonly mediaType?: string;
}

export interface StructuredJobResult {
  readonly summary: JsonObject;
  readonly artifacts: readonly JobArtifact[];
  readonly completedAt: string;
}

export interface JobAttemptSummary {
  readonly attempt: number;
  readonly workerId?: WorkerId;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?:
    | "completed"
    | "failed"
    | "paused"
    | "cancelled"
    | "lease-expired";
  readonly error?: StructuredJobError;
}

export interface PersistentJobRecord {
  readonly id: JobId;
  readonly revision: number;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly payload: JsonObject;
  readonly priority: number;
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly controlPolicy: JobControlPolicy;
  readonly progress?: JobProgress;
  readonly checkpoint?: JsonObject;
  readonly result?: StructuredJobResult;
  readonly error?: StructuredJobError;
  readonly attempts: readonly JobAttemptSummary[];
  readonly submittedAt: string;
  readonly updatedAt: string;
}

export type JobHistoryEventKind =
  | "submitted"
  | "claimed"
  | "progress-reported"
  | "checkpoint-saved"
  | "pause-requested"
  | "paused"
  | "resume-requested"
  | "cancel-requested"
  | "cancelled"
  | "completed"
  | "failed"
  | "lease-expired"
  | "requeued-after-recovery";

export interface JobHistoryEvent {
  readonly id: JobEventId;
  readonly jobId: JobId;
  readonly sequence: number;
  readonly kind: JobHistoryEventKind;
  readonly fromStatus?: JobStatus;
  readonly toStatus: JobStatus;
  readonly workerId?: WorkerId;
  readonly details: JsonObject;
  readonly occurredAt: string;
}

export interface JobStatusView {
  readonly jobId: JobId;
  readonly status: JobStatus;
  readonly progress?: JobProgress;
  readonly submittedAt: string;
  readonly updatedAt: string;
}

export interface JobResultView {
  readonly jobId: JobId;
  readonly status: JobStatus;
  readonly result?: StructuredJobResult;
  readonly error?: StructuredJobError;
}

export interface JobHistoryPage {
  readonly events: readonly JobHistoryEvent[];
  readonly nextSequence?: number;
}
