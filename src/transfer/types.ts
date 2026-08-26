import type { JsonObject } from "../domain/index.js";

export type TransferPlanKind =
  | "ingest"
  | "cross-volume-organization"
  | "duplicate-consolidation";

export type TransferPlanStatus =
  | "draft"
  | "analysis-queued"
  | "analyzing"
  | "needs-review"
  | "ready-for-approval"
  | "approved"
  | "transfer-queued"
  | "transferring"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type TransferItemStatus =
  | "discovered"
  | "exact-duplicate"
  | "needs-review"
  | "ready"
  | "copying"
  | "verified"
  | "quarantined"
  | "completed"
  | "failed";

export interface DurableTransferPlan {
  readonly id: string;
  readonly kind: TransferPlanKind;
  readonly sourceRootId: string;
  readonly sourceRootIdentityKey: string;
  readonly sourceDisplayPath: string;
  readonly destinationRootId?: string;
  readonly destinationRootIdentityKey?: string;
  readonly targetDirectory?: string;
  readonly retireSource: boolean;
  readonly preserveSourceFolders: boolean;
  readonly status: TransferPlanStatus;
  readonly analysisJobId?: string;
  readonly transferJobId?: string;
  readonly counts: {
    readonly total: number;
    readonly ready: number;
    readonly exactDuplicates: number;
    readonly needsReview: number;
    readonly completed: number;
    readonly quarantined: number;
    readonly failed: number;
    readonly totalBytes: number;
    readonly copiedBytes: number;
  };
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface DurableTransferItem {
  readonly id: string;
  readonly planId: string;
  readonly ordinal: number;
  readonly sourceRelativePath: string;
  readonly originalSourcePath: string;
  readonly originalFileName: string;
  readonly destinationRelativePath?: string;
  readonly byteLength: number;
  readonly sourceModifiedAt?: string;
  readonly sourceDeviceId?: string;
  readonly sourceFilesystemRecordId?: string;
  readonly algorithm?: "sha256";
  readonly digestHex?: string;
  readonly category?: string;
  readonly mimeType?: string;
  readonly confidence?: number;
  readonly explanation?: string;
  readonly metadata: JsonObject;
  readonly duplicateMatches: readonly {
    readonly recordId: string;
    readonly rootId: string;
    readonly relativePath: string;
  }[];
  readonly status: TransferItemStatus;
  readonly copiedBytes: number;
  readonly destinationVerifiedAt?: string;
  readonly quarantineItemId?: string;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  readonly updatedAt: string;
}

export interface TransferPlanPage {
  readonly items: readonly DurableTransferPlan[];
  readonly nextCursor?: string;
}

export interface TransferItemPage {
  readonly items: readonly DurableTransferItem[];
  readonly nextCursor?: string;
}

export type QuarantineStatus = "active" | "restoring" | "restored" | "restore-blocked";

export interface QuarantineItem {
  readonly id: string;
  readonly rootId: string;
  readonly rootIdentityKey: string;
  readonly originalRelativePath: string;
  readonly quarantinedRelativePath: string;
  readonly originalFileName: string;
  readonly algorithm: "sha256";
  readonly digestHex: string;
  readonly byteLength: number;
  readonly reason: "duplicate-consolidation" | "verified-source-retirement";
  readonly planId: string;
  readonly transferItemId: string;
  readonly jobId: string;
  readonly status: QuarantineStatus;
  readonly quarantinedAt: string;
  readonly restoredAt?: string;
  readonly restoreJobId?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface QuarantinePage {
  readonly items: readonly QuarantineItem[];
  readonly nextCursor?: string;
}

export interface TransferReceipt {
  readonly formatVersion: 2;
  readonly id: string;
  readonly planId: string;
  readonly jobId: string;
  readonly kind: TransferPlanKind;
  readonly status: "completed" | "partial" | "failed";
  readonly counts: DurableTransferPlan["counts"];
  readonly completedAt: string;
}

export interface TransferAuditEvent {
  readonly sequence: number;
  readonly id: string;
  readonly event: string;
  readonly entityId: string;
  readonly details: JsonObject;
  readonly previousHash: string;
  readonly hash: string;
  readonly occurredAt: string;
}
