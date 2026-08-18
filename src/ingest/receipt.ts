import type {
  ContentIdentity,
  IngestFileProvenance,
  IngestItemId,
  IngestReceiptId,
  IngestSessionId,
  JobId,
  LibraryLocation,
} from "../domain/index.js";
import type { ExactDuplicateMatch } from "./ingest-item.js";

interface IngestReceiptItemBase {
  readonly ingestItemId: IngestItemId;
  readonly provenance: IngestFileProvenance;
}

export type IngestReceiptItem =
  | (IngestReceiptItemBase & {
      readonly outcome: "imported";
      readonly identity: ContentIdentity;
      readonly destination: LibraryLocation;
      readonly verified: true;
    })
  | (IngestReceiptItemBase & {
      readonly outcome: "exact-duplicate";
      readonly identity: ContentIdentity;
      readonly matches: readonly ExactDuplicateMatch[];
    })
  | (IngestReceiptItemBase & {
      readonly outcome: "skipped";
      readonly reason: string;
    })
  | (IngestReceiptItemBase & {
      readonly outcome: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    })
  | (IngestReceiptItemBase & {
      readonly outcome: "review-required";
      readonly reason: string;
    });

export type IngestReceiptOutcome = IngestReceiptItem["outcome"];

export interface IngestReceiptCounts {
  readonly discovered: number;
  readonly imported: number;
  readonly exactDuplicates: number;
  readonly skipped: number;
  readonly failed: number;
  readonly reviewRequired: number;
}

export function countIngestReceiptItems(
  items: readonly { readonly outcome: IngestReceiptOutcome }[],
): IngestReceiptCounts {
  const count = (outcome: IngestReceiptOutcome): number =>
    items.filter((item) => item.outcome === outcome).length;

  return {
    discovered: items.length,
    imported: count("imported"),
    exactDuplicates: count("exact-duplicate"),
    skipped: count("skipped"),
    failed: count("failed"),
    reviewRequired: count("review-required"),
  };
}

export interface IngestReceipt {
  readonly formatVersion: 1;
  readonly id: IngestReceiptId;
  readonly sessionId: IngestSessionId;
  readonly jobId: JobId;
  readonly status: "completed" | "partial" | "review-required" | "failed";
  readonly counts: IngestReceiptCounts;
  readonly items: readonly IngestReceiptItem[];
  readonly journalCorrelationId: string;
  readonly completedAt: string;
}

export interface IngestReceiptStore {
  save(receipt: IngestReceipt): Promise<void>;
  get(id: IngestReceiptId): Promise<IngestReceipt | undefined>;
  getBySession(sessionId: IngestSessionId): Promise<IngestReceipt | undefined>;
}
