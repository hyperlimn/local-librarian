import type { JobId } from "../domain/index.js";
import type {
  JobHistoryPage,
  JobResultView,
  JobStatusView,
  JobSubmission,
  JobSubmissionReceipt,
} from "../jobs/index.js";

/**
 * MCP-facing facade. submit() may wait for a durable queue commit only; no
 * handler, worker, scan, hash, or transfer runs in the request lifecycle.
 */
export interface McpJobTools<SubmissionInput = JobSubmission> {
  submit(input: SubmissionInput): Promise<JobSubmissionReceipt>;
  status(jobId: JobId): Promise<JobStatusView | undefined>;
  result(jobId: JobId): Promise<JobResultView | undefined>;
  history(
    jobId: JobId,
    afterSequence?: number,
    limit?: number,
  ): Promise<JobHistoryPage>;
  pause(jobId: JobId, requestedBy: string): Promise<JobStatusView>;
  resume(jobId: JobId, requestedBy: string): Promise<JobStatusView>;
  cancel(jobId: JobId, requestedBy: string): Promise<JobStatusView>;
}
