import type {
  InventoryRecord,
  ReconciliationComparableFacts,
  ReconciliationDelta,
  ReconciliationReport,
} from "../domain/index.js";
import type { InventoryScanId, LibraryRootId } from "../domain/index.js";

export class ReconciliationRootMismatchError extends Error {
  public constructor() {
    super("Both scan sessions must belong to the same library root.");
    this.name = "ReconciliationRootMismatchError";
  }
}

export interface ReconcileInput {
  readonly rootId: LibraryRootId;
  readonly baselineScanId: InventoryScanId;
  readonly comparisonScanId: InventoryScanId;
  readonly baselineRecords: readonly InventoryRecord[];
  readonly comparisonRecords: readonly InventoryRecord[];
  readonly now?: () => string;
}

const COMPARABLE_FACT_KEYS: readonly (keyof ReconciliationComparableFacts)[] = [
  "entryType",
  "byteLength",
  "modifiedAt",
  "attributes",
];

/**
 * Pure diff between two already-loaded sets of inventory observations.
 * Performs no filesystem or database access and mutates neither input.
 * Only "observed" records participate; "skipped"/"error" entries are
 * excluded because they carry no comparable metadata.
 */
export function reconcile(input: ReconcileInput): ReconciliationReport {
  for (const record of [...input.baselineRecords, ...input.comparisonRecords]) {
    if (record.rootId !== input.rootId) {
      throw new ReconciliationRootMismatchError();
    }
  }

  const baseline = indexByPath(input.baselineRecords);
  const comparison = indexByPath(input.comparisonRecords);

  const deltas: ReconciliationDelta[] = [];

  for (const [relativePath, before] of baseline) {
    const after = comparison.get(relativePath);
    if (after === undefined) {
      deltas.push({ relativePath, kind: "missing", before });
      continue;
    }
    const changedFields = comparableFactDiff(before, after);
    if (changedFields.length > 0) {
      deltas.push({
        relativePath,
        kind: "metadata-changed",
        before,
        after,
        changedFields,
      });
    }
  }

  for (const [relativePath, after] of comparison) {
    if (!baseline.has(relativePath)) {
      deltas.push({ relativePath, kind: "added", after });
    }
  }

  deltas.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    rootId: input.rootId,
    baselineScanId: input.baselineScanId,
    comparisonScanId: input.comparisonScanId,
    deltas,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

function indexByPath(
  records: readonly InventoryRecord[],
): Map<InventoryRecord["relativePath"], InventoryRecord> {
  const map = new Map<InventoryRecord["relativePath"], InventoryRecord>();
  for (const record of records) {
    if (record.observationStatus !== "observed") continue;
    map.set(record.relativePath, record);
  }
  return map;
}

function comparableFactDiff(
  before: InventoryRecord,
  after: InventoryRecord,
): readonly (keyof ReconciliationComparableFacts)[] {
  const changed: (keyof ReconciliationComparableFacts)[] = [];
  for (const key of COMPARABLE_FACT_KEYS) {
    if (!factEquals(before[key], after[key])) changed.push(key);
  }
  return changed;
}

function factEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}