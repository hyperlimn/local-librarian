import type { InventoryRecord } from "./inventory.js";
import type {
  InventoryScanId,
  LibraryRootId,
  RootRelativePath,
} from "./ids.js";

/**
 * The comparable subset of an InventoryRecord's metadata. Deliberately
 * excludes identifiers (id, scanId, jobId) and observedAt, since those
 * differ between any two scan sessions by construction and would make
 * every record look "changed".
 */
export interface ReconciliationComparableFacts {
  readonly entryType: InventoryRecord["entryType"];
  readonly byteLength?: number;
  readonly modifiedAt?: string;
  readonly attributes: InventoryRecord["attributes"];
}

export type ReconciliationDeltaKind = "added" | "missing" | "metadata-changed";

interface ReconciliationDeltaBase {
  readonly relativePath: RootRelativePath;
  readonly kind: ReconciliationDeltaKind;
}

export interface ReconciliationAddedDelta extends ReconciliationDeltaBase {
  readonly kind: "added";
  readonly after: InventoryRecord;
}

export interface ReconciliationMissingDelta extends ReconciliationDeltaBase {
  readonly kind: "missing";
  readonly before: InventoryRecord;
}

export interface ReconciliationChangedDelta extends ReconciliationDeltaBase {
  readonly kind: "metadata-changed";
  readonly before: InventoryRecord;
  readonly after: InventoryRecord;
  /** Which comparable fact keys differed, for display purposes. */
  readonly changedFields: readonly (keyof ReconciliationComparableFacts)[];
}

export type ReconciliationDelta =
  | ReconciliationAddedDelta
  | ReconciliationMissingDelta
  | ReconciliationChangedDelta;

export interface ReconciliationReport {
  readonly rootId: LibraryRootId;
  readonly baselineScanId: InventoryScanId;
  readonly comparisonScanId: InventoryScanId;
  readonly deltas: readonly ReconciliationDelta[];
  readonly generatedAt: string;
}