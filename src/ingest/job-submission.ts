import type {
  IngestPlanId,
  IngestSessionId,
  IngestSourceId,
} from "../domain/index.js";
import type {
  JobClient,
  JobSubmission,
  JobSubmissionReceipt,
} from "../jobs/index.js";
import type { IngestPlan } from "./ingest-plan.js";

export interface IngestPipelineJobReference {
  readonly planId: IngestPlanId;
  readonly sessionId: IngestSessionId;
}

export function createIngestAnalysisJobSubmission(
  sessionId: IngestSessionId,
  sourceId: IngestSourceId,
  requestedBy: string,
): JobSubmission {
  return {
    kind: "ingest.analyze",
    payload: {
      sessionId,
      sourceId,
    },
    priority: 0,
    idempotencyKey: `ingest-analysis:${sessionId}`,
    requestedBy,
    controlPolicy: {
      pauseMode: "checkpoint",
      cancellationMode: "cooperative",
      maximumAttempts: 3,
      leaseDurationMilliseconds: 30_000,
    },
  };
}

export function createIngestTransferJobSubmission(
  plan: IngestPlan,
  requestedBy: string,
): JobSubmission {
  if (plan.status !== "approved") {
    throw new Error("Only an approved ingest plan can be submitted as a job.");
  }

  if (plan.items.some((item) => item.disposition === "review-required")) {
    throw new Error("An ingest plan with unresolved review items cannot run.");
  }

  return {
    kind: "ingest.transfer",
    payload: {
      planId: plan.id,
      sessionId: plan.sessionId,
      receiptFormatVersion: 1,
    },
    priority: 0,
    idempotencyKey: `ingest-plan:${plan.id}`,
    requestedBy,
    controlPolicy: {
      pauseMode: "checkpoint",
      cancellationMode: "cooperative",
      maximumAttempts: 3,
      leaseDurationMilliseconds: 30_000,
    },
  };
}

/** Enqueues durably and returns; it never waits for the ingest pipeline. */
export interface IngestJobSubmissionService {
  readonly jobs: JobClient;
  submitAnalysis(
    sessionId: IngestSessionId,
    sourceId: IngestSourceId,
    requestedBy: string,
  ): Promise<JobSubmissionReceipt>;
  submitApprovedPlan(
    plan: IngestPlan,
    requestedBy: string,
  ): Promise<JobSubmissionReceipt>;
}
