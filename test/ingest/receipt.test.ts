import { describe, expect, it } from "vitest";

import type { IngestReceiptOutcome } from "../../src/ingest/index.js";
import {
  countIngestReceiptItems,
  INGEST_ANALYSIS_STAGES,
} from "../../src/ingest/index.js";

const receiptItem = (
  outcome: IngestReceiptOutcome,
): { readonly outcome: IngestReceiptOutcome } => ({ outcome });

describe("ingest receipts", () => {
  it("summarizes every required outcome", () => {
    const items = [
      receiptItem("imported"),
      receiptItem("imported"),
      receiptItem("exact-duplicate"),
      receiptItem("skipped"),
      receiptItem("failed"),
      receiptItem("review-required"),
    ];

    expect(countIngestReceiptItems(items)).toEqual({
      discovered: 6,
      imported: 2,
      exactDuplicates: 1,
      skipped: 1,
      failed: 1,
      reviewRequired: 1,
    });
  });

  it("checks exact duplicates before analysis, classification, and planning", () => {
    const duplicateStage = INGEST_ANALYSIS_STAGES.indexOf(
      "exact-duplicate-detection",
    );

    expect(duplicateStage).toBeLessThan(
      INGEST_ANALYSIS_STAGES.indexOf("metadata-media-analysis"),
    );
    expect(duplicateStage).toBeLessThan(
      INGEST_ANALYSIS_STAGES.indexOf("classification"),
    );
    expect(duplicateStage).toBeLessThan(
      INGEST_ANALYSIS_STAGES.indexOf("destination-planning"),
    );
  });
});
