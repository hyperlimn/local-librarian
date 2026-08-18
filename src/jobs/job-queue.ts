import type {
  JobId,
  JobLeaseId,
  JsonObject,
  WorkerId,
} from "../domain/index.js";
import type {
  JobHistoryPage,
  JobKind,
  JobProgress,
  JobResultView,
  JobStatusView,
  JobSubmission,
  JobSubmissionReceipt,
  StructuredJobError,
  StructuredJobResult,
} from "./job.js";

export interface JobLease {
  readonly id: JobLeaseId;
  readonly jobId: JobId;
  readonly workerId: WorkerId;
  readonly attempt: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly checkpoint?: JsonObject;
}

export type WorkerControlSignal = "continue" | "pause" | "cancel";

export interface JobRecoveryReport {
  readonly checkedAt: string;
  readonly expiredLeaseCount: number;
  readonly requeuedJobIds: readonly JobId[];
  readonly failedJobIds: readonly JobId[];
}

/** MCP-facing commands. submit() returns after durable enqueue, never job work. */
export interface JobClient {
  submit(submission: JobSubmission): Promise<JobSubmissionReceipt>;
  status(jobId: JobId): Promise<JobStatusView | undefined>;
  result(jobId: JobId): Promise<JobResultView | undefined>;
  history(
    jobId: JobId,
    afterSequence?: number,
    limit?: number,
  ): Promise<JobHistoryPage>;
  requestPause(jobId: JobId, requestedBy: string): Promise<JobStatusView>;
  resume(jobId: JobId, requestedBy: string): Promise<JobStatusView>;
  cancel(jobId: JobId, requestedBy: string): Promise<JobStatusView>;
}

/** Worker-facing durable queue operations, all guarded by a lease token. */
export interface WorkerJobQueue {
  claimNext(
    workerId: WorkerId,
    supportedKinds?: readonly JobKind[],
  ): Promise<JobLease | undefined>;
  loadLeasedJob(
    lease: JobLease,
  ): Promise<import("./job.js").PersistentJobRecord>;
  heartbeat(lease: JobLease, progress?: JobProgress): Promise<JobLease>;
  saveCheckpoint(lease: JobLease, checkpoint: JsonObject): Promise<void>;
  complete(lease: JobLease, result: StructuredJobResult): Promise<void>;
  fail(lease: JobLease, error: StructuredJobError): Promise<void>;
  acknowledgePaused(lease: JobLease, checkpoint?: JsonObject): Promise<void>;
  acknowledgeCancelled(lease: JobLease, details: JsonObject): Promise<void>;
  controlSignal(lease: JobLease): Promise<WorkerControlSignal>;
  recoverExpiredLeases(now: string): Promise<JobRecoveryReport>;
}

export interface PersistentJobQueue extends JobClient, WorkerJobQueue {}
