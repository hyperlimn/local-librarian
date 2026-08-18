import type {
  ApprovedRootId,
  IngestSessionId,
  JobId,
  JournalEntryId,
  OperationId,
  PlanId,
} from "./ids.js";
import type { ProposedOperation } from "./proposed-operation.js";
import type { JsonObject } from "./json.js";

export type JournalEvent =
  | "root.proposed"
  | "root.approved"
  | "root.revoked"
  | "plan.proposed"
  | "plan.approved"
  | "plan.rejected"
  | "operation.validated"
  | "operation.started"
  | "operation.succeeded"
  | "operation.failed"
  | "rollback.proposed"
  | "rollback.started"
  | "rollback.succeeded"
  | "rollback.failed"
  | "ingest.plan-created"
  | "ingest.reviewed"
  | "ingest.submitted"
  | "ingest.completed"
  | "job.submitted"
  | "job.started"
  | "job.paused"
  | "job.resumed"
  | "job.recovered"
  | "job.completed"
  | "job.failed"
  | "job.cancelled";

export type JournalActor =
  | { readonly kind: "human"; readonly id: string }
  | { readonly kind: "mcp-client"; readonly id: string }
  | { readonly kind: "system"; readonly id: string };

export interface JournalPayload {
  readonly rootId?: ApprovedRootId;
  readonly jobId?: JobId;
  readonly ingestSessionId?: IngestSessionId;
  readonly planId?: PlanId;
  readonly operationId?: OperationId;
  readonly operationSnapshot?: ProposedOperation;
  readonly inverseOperation?: ProposedOperation;
  readonly message?: string;
  readonly details?: JsonObject;
}

/** One immutable JSONL record in the append-only audit chain. */
export interface JournalEntry {
  readonly id: JournalEntryId;
  readonly sequence: number;
  readonly event: JournalEvent;
  readonly occurredAt: string;
  readonly actor: JournalActor;
  readonly correlationId: string;
  readonly previousEntryHash?: string;
  readonly entryHash: string;
  readonly payload: JournalPayload;
}
