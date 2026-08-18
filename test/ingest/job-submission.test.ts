import { describe, expect, it } from "vitest";

import type {
  IngestPlanId,
  IngestItemId,
  IngestSessionId,
  IngestSourceId,
} from "../../src/domain/index.js";
import {
  createIngestAnalysisJobSubmission,
  createIngestTransferJobSubmission,
  type IngestPlan,
  type IngestPlanItem,
} from "../../src/ingest/index.js";

function plan(
  status: IngestPlan["status"],
  items: readonly IngestPlanItem[] = [],
): IngestPlan {
  return {
    id: "ingest-plan-1" as IngestPlanId,
    sessionId: "ingest-session-1" as IngestSessionId,
    status,
    items,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("createIngestTransferJobSubmission", () => {
  it("creates a separate non-executing analysis job", () => {
    expect(
      createIngestAnalysisJobSubmission(
        "ingest-session-1" as IngestSessionId,
        "ingest-source-1" as IngestSourceId,
        "test-user",
      ),
    ).toMatchObject({
      kind: "ingest.analyze",
      idempotencyKey: "ingest-analysis:ingest-session-1",
    });
  });

  it("creates an idempotent background job only for an approved plan", () => {
    expect(
      createIngestTransferJobSubmission(plan("approved"), "test-user"),
    ).toMatchObject({
      kind: "ingest.transfer",
      idempotencyKey: "ingest-plan:ingest-plan-1",
      requestedBy: "test-user",
      controlPolicy: { pauseMode: "checkpoint" },
    });
  });

  it("refuses uncertain or unapproved plans", () => {
    expect(() =>
      createIngestTransferJobSubmission(plan("review-required"), "test-user"),
    ).toThrow("Only an approved ingest plan");

    expect(() =>
      createIngestTransferJobSubmission(
        plan("approved", [
          {
            disposition: "review-required",
            ingestItemId: "ingest-item-1" as IngestItemId,
            classification: {
              status: "review-required",
              reason: "low-confidence",
              candidates: [],
              destinationCandidates: [],
            },
            transferRequired: false,
          },
        ]),
        "test-user",
      ),
    ).toThrow("unresolved review items");
  });
});
