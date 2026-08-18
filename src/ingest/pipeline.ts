import type { IngestPlan, IngestPlanningPolicy } from "./ingest-plan.js";
import type { ApprovedIngestSource } from "./source.js";

export const INGEST_ANALYSIS_STAGES = [
  "inventory",
  "content-identity",
  "exact-duplicate-detection",
  "metadata-media-analysis",
  "classification",
  "destination-planning",
  "human-review",
] as const;

export const INGEST_EXECUTION_STAGES = [
  "background-transfer",
  "content-identity-verification",
  "catalog-update",
  "journal-and-receipt",
] as const;

export interface IngestAnalysisRequest {
  readonly source: ApprovedIngestSource;
  readonly policy: IngestPlanningPolicy;
}

/**
 * Worker-side analysis port. It terminates at a reviewable plan and is never
 * called directly within an MCP request.
 */
export interface IngestAnalysisService {
  analyze(request: IngestAnalysisRequest): Promise<IngestPlan>;
}
