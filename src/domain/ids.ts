declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type LibraryRootId = Brand<string, "LibraryRootId">;
export type IngestSourceId = Brand<string, "IngestSourceId">;
export type IngestSessionId = Brand<string, "IngestSessionId">;
export type IngestItemId = Brand<string, "IngestItemId">;
export type IngestPlanId = Brand<string, "IngestPlanId">;
export type IngestReceiptId = Brand<string, "IngestReceiptId">;
export type IndexedFileId = Brand<string, "IndexedFileId">;
export type ContentId = Brand<string, "ContentId">;
export type PlanId = Brand<string, "PlanId">;
export type OperationId = Brand<string, "OperationId">;
export type JournalEntryId = Brand<string, "JournalEntryId">;
export type JobId = Brand<string, "JobId">;
export type JobEventId = Brand<string, "JobEventId">;
export type JobLeaseId = Brand<string, "JobLeaseId">;
export type WorkerId = Brand<string, "WorkerId">;
export type InventoryScanId = Brand<string, "InventoryScanId">;
export type InventoryRecordId = Brand<string, "InventoryRecordId">;
export type CanonicalAbsolutePath = Brand<string, "CanonicalAbsolutePath">;
export type RootRelativePath = Brand<string, "RootRelativePath">;

export type ApprovedRootId = LibraryRootId | IngestSourceId;
