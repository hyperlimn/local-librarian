import type {
  InventoryRecord,
  InventoryScanId,
  LibraryRootId,
  ReconciliationReport,
} from "../domain/index.js";
import type { InventoryCatalog } from "../catalog/index.js";
import { reconcile, ReconciliationRootMismatchError } from "./reconcile.js";

export class ReconciliationScanNotFoundError extends Error {
  public constructor(public readonly scanId: InventoryScanId) {
    super(`Scan session ${scanId} was not found.`);
    this.name = "ReconciliationScanNotFoundError";
  }
}

export class ReconciliationScanNotCompletedError extends Error {
  public constructor(public readonly scanId: InventoryScanId) {
    super(`Scan session ${scanId} has not completed and cannot be reconciled.`);
    this.name = "ReconciliationScanNotCompletedError";
  }
}

export interface ReconciliationServiceInput {
  readonly rootId: LibraryRootId;
  readonly baselineScanId: InventoryScanId;
  readonly comparisonScanId: InventoryScanId;
}

export interface McpReconciliationTools {
  compare(input: ReconciliationServiceInput): Promise<ReconciliationReport>;
}

/**
 * Loads two completed scan sessions for the same root from the catalog and
 * diffs their observations. Performs no filesystem access and writes
 * nothing; it only reads through the existing InventoryCatalog port.
 */
export class ReconciliationService implements McpReconciliationTools {
  public constructor(private readonly catalog: InventoryCatalog) {}

  public async compare(
    input: ReconciliationServiceInput,
  ): Promise<ReconciliationReport> {
    const [baselineSession, comparisonSession] = await Promise.all([
      this.loadCompletedSession(input.baselineScanId),
      this.loadCompletedSession(input.comparisonScanId),
    ]);

    if (
      baselineSession.rootId !== input.rootId ||
      comparisonSession.rootId !== input.rootId
    ) {
      throw new ReconciliationRootMismatchError();
    }

    const [baselineRecords, comparisonRecords] = await Promise.all([
      this.loadAllRecords(input.rootId, input.baselineScanId),
      this.loadAllRecords(input.rootId, input.comparisonScanId),
    ]);

    return reconcile({
      rootId: input.rootId,
      baselineScanId: input.baselineScanId,
      comparisonScanId: input.comparisonScanId,
      baselineRecords,
      comparisonRecords,
    });
  }

  private async loadCompletedSession(scanId: InventoryScanId) {
    const session = await this.catalog.getScan(scanId);
    if (session === undefined) {
      throw new ReconciliationScanNotFoundError(scanId);
    }
    if (session.status !== "completed") {
      throw new ReconciliationScanNotCompletedError(scanId);
    }
    return session;
  }

  private async loadAllRecords(
    rootId: LibraryRootId,
    scanId: InventoryScanId,
  ): Promise<readonly InventoryRecord[]> {
    const records: InventoryRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.catalog.list(rootId, {
        scanId,
        limit: 1_000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      records.push(...page.items);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    return records;
  }
}