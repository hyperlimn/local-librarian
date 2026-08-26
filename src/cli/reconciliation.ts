import type {
  InventoryScanId,
  LibraryRootId,
} from "../domain/index.js";
import { SqliteInventoryCatalog } from "../catalog/index.js";
import { SqlitePersistentJobQueue } from "../jobs/index.js";
import {
  RECONCILIATION_JOB_DEFINITION,
  ScalableReconciliationService,
  SqliteIntelligenceStore,
} from "../intelligence/index.js";
import { localStatePaths } from "./local-state.js";

async function main(): Promise<void> {
  const [stateDirectory, rootId, baselineScanId, comparisonScanId] =
    process.argv.slice(2);
  if (
    stateDirectory === undefined ||
    rootId === undefined ||
    baselineScanId === undefined ||
    comparisonScanId === undefined
  ) {
    throw new Error(
      "Usage: reconcile <state-directory> <root-id> <baseline-scan-id> <comparison-scan-id>",
    );
  }
  const paths = localStatePaths(stateDirectory);
  const catalog = new SqliteInventoryCatalog({
    databasePath: paths.inventoryDatabase,
  });
  const intelligence = new SqliteIntelligenceStore({ databasePath: paths.inventoryDatabase });
  const jobs = new SqlitePersistentJobQueue({
    databasePath: paths.jobsDatabase,
    definitions: [RECONCILIATION_JOB_DEFINITION],
  });
  try {
    const service = new ScalableReconciliationService(intelligence, jobs);
    const report = await service.compare({
      rootId: rootId as LibraryRootId,
      baselineScanId: baselineScanId as InventoryScanId,
      comparisonScanId: comparisonScanId as InventoryScanId,
      requestedBy: "cli",
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    jobs.close();
    intelligence.close();
    catalog.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
