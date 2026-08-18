import type { JobId } from "../domain/index.js";
import type {
  JobClient,
  JobHistoryPage,
  JobResultView,
  JobStatusView,
  JobSubmissionReceipt,
} from "../jobs/index.js";
import type { McpJobTools } from "./job-tools.js";

export interface DiagnosticCountSubmissionInput {
  readonly iterations: number;
  readonly idempotencyKey: string;
  readonly requestedBy?: string;
  readonly priority?: number;
  readonly maximumAttempts?: number;
  readonly leaseDurationMilliseconds?: number;
}

/**
 * Narrow MCP-facing application service. It cannot submit a filesystem job:
 * the job kind is fixed here rather than accepted from client input.
 */
export class DiagnosticJobTools
  implements McpJobTools<DiagnosticCountSubmissionInput>
{
  readonly #client: JobClient;

  public constructor(client: JobClient) {
    this.#client = client;
  }

  public submit(input: DiagnosticCountSubmissionInput): Promise<JobSubmissionReceipt> {
    return this.#client.submit({
      kind: "diagnostic.count",
      payload: { iterations: input.iterations },
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy ?? "mcp",
      controlPolicy: {
        pauseMode: "checkpoint",
        cancellationMode: "cooperative",
        maximumAttempts: input.maximumAttempts ?? 3,
        leaseDurationMilliseconds: input.leaseDurationMilliseconds ?? 30_000,
      },
    });
  }

  public status(jobId: JobId): Promise<JobStatusView | undefined> {
    return this.#client.status(jobId);
  }

  public result(jobId: JobId): Promise<JobResultView | undefined> {
    return this.#client.result(jobId);
  }

  public history(
    jobId: JobId,
    afterSequence?: number,
    limit?: number,
  ): Promise<JobHistoryPage> {
    return this.#client.history(jobId, afterSequence, limit);
  }

  public pause(jobId: JobId, requestedBy: string): Promise<JobStatusView> {
    return this.#client.requestPause(jobId, requestedBy);
  }

  public resume(jobId: JobId, requestedBy: string): Promise<JobStatusView> {
    return this.#client.resume(jobId, requestedBy);
  }

  public cancel(jobId: JobId, requestedBy: string): Promise<JobStatusView> {
    return this.#client.cancel(jobId, requestedBy);
  }
}

