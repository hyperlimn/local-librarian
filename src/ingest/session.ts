import type {
  IngestItemId,
  IngestPlanId,
  IngestReceiptId,
  IngestSessionId,
  IngestSourceId,
  JobId,
} from "../domain/index.js";
import type {
  AnalyzedIngestItem,
  IngestInventoryItem,
} from "./ingest-item.js";
import type { IngestPlan } from "./ingest-plan.js";
import type { IngestReceipt } from "./receipt.js";
import type { IngestSource } from "./source.js";

export type IngestSessionStatus =
  | "created"
  | "analysis-queued"
  | "analyzing"
  | "review-required"
  | "ready-for-approval"
  | "transfer-queued"
  | "transferring"
  | "completed"
  | "failed"
  | "cancelled";

export interface IngestSession {
  readonly id: IngestSessionId;
  readonly revision: number;
  readonly sourceId: IngestSourceId;
  readonly status: IngestSessionStatus;
  readonly analysisJobId?: JobId;
  readonly transferJobId?: JobId;
  readonly planId?: IngestPlanId;
  readonly receiptId?: IngestReceiptId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Persistent ingest state port; a future SQLite adapter owns transactions. */
export interface IngestStore {
  saveSource(source: IngestSource): Promise<void>;
  getSource(id: IngestSourceId): Promise<IngestSource | undefined>;
  createSession(session: IngestSession): Promise<void>;
  getSession(id: IngestSessionId): Promise<IngestSession | undefined>;
  updateSession(
    expectedRevision: number,
    session: IngestSession,
  ): Promise<boolean>;
  saveInventoryItems(items: readonly IngestInventoryItem[]): Promise<void>;
  getInventoryItem(id: IngestItemId): Promise<IngestInventoryItem | undefined>;
  saveAnalyzedItems(items: readonly AnalyzedIngestItem[]): Promise<void>;
  savePlan(plan: IngestPlan): Promise<void>;
  getPlan(id: IngestPlanId): Promise<IngestPlan | undefined>;
  saveReceipt(receipt: IngestReceipt): Promise<void>;
  getReceipt(id: IngestReceiptId): Promise<IngestReceipt | undefined>;
}

export const INGEST_STORE_IMPLEMENTATION_STATUS = "scaffold-only" as const;
