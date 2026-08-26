import type { WorkerId } from "../domain/index.js";
import { SqliteInventoryCatalog } from "../catalog/index.js";
import {
  JsonlRootEnrollmentStore,
  SystemVolumeIdentityProvider,
} from "../enrollment/index.js";
import {
  DIAGNOSTIC_COUNT_JOB_DEFINITION,
  DiagnosticCountJobHandler,
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
  WorkerHeartbeat,
  WorkerStatusStore,
} from "../jobs/index.js";
import {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
} from "../safety/index.js";
import {
  ORGANIZATION_EXECUTE_JOB_DEFINITION,
  ORGANIZATION_ROLLBACK_JOB_DEFINITION,
  OrganizationExecutionJobHandler,
  OrganizationRollbackJobHandler,
  SqliteOrganizationStore,
} from "../organization/index.js";
import {
  INVENTORY_SCAN_JOB_DEFINITION,
  InventoryRootGuard,
  InventoryScanJobHandler,
} from "../scanner/index.js";
import { localStatePaths } from "./local-state.js";
import {
  CONTENT_HASH_JOB_DEFINITION,
  DUPLICATE_DETECTION_JOB_DEFINITION,
  METADATA_ANALYSIS_JOB_DEFINITION,
  RECONCILIATION_JOB_DEFINITION,
  RELATIONSHIP_ANALYSIS_JOB_DEFINITION,
  ContentHashJobHandler,
  DuplicateCandidateJobHandler,
  MetadataAnalysisJobHandler,
  ReconciliationJobHandler,
  RelationshipAnalysisJobHandler,
  SqliteIntelligenceStore,
} from "../intelligence/index.js";
import {
  CROSS_VOLUME_TRANSFER_JOB_DEFINITION,
  CrossVolumeTransferJobHandler,
  INGEST_ANALYSIS_JOB_DEFINITION,
  INGEST_TRANSFER_JOB_DEFINITION,
  IngestAnalysisJobHandler,
  IngestTransferJobHandler,
  QUARANTINE_EXECUTE_JOB_DEFINITION,
  QUARANTINE_RESTORE_JOB_DEFINITION,
  QuarantineExecutionJobHandler,
  QuarantineRestoreJobHandler,
  SqliteTransferStore,
  TransferRootGuard,
} from "../transfer/index.js";

async function main(): Promise<void> {
  const [stateDirectory, mode] = process.argv.slice(2);
  if (stateDirectory === undefined) {
    throw new Error("Usage: local-worker <state-directory> [--once]");
  }
  const paths = localStatePaths(stateDirectory);
  const queue = new SqlitePersistentJobQueue({
    databasePath: paths.jobsDatabase,
    definitions: [
      DIAGNOSTIC_COUNT_JOB_DEFINITION,
      INVENTORY_SCAN_JOB_DEFINITION,
      ORGANIZATION_EXECUTE_JOB_DEFINITION,
      ORGANIZATION_ROLLBACK_JOB_DEFINITION,
      DUPLICATE_DETECTION_JOB_DEFINITION,
      CONTENT_HASH_JOB_DEFINITION,
      METADATA_ANALYSIS_JOB_DEFINITION,
      RELATIONSHIP_ANALYSIS_JOB_DEFINITION,
      RECONCILIATION_JOB_DEFINITION,
      INGEST_ANALYSIS_JOB_DEFINITION,
      INGEST_TRANSFER_JOB_DEFINITION,
      CROSS_VOLUME_TRANSFER_JOB_DEFINITION,
      QUARANTINE_EXECUTE_JOB_DEFINITION,
      QUARANTINE_RESTORE_JOB_DEFINITION,
    ],
  });
  const catalog = new SqliteInventoryCatalog({
    databasePath: paths.inventoryDatabase,
  });
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  const boundary = new PathBoundary(
    process.platform === "win32" ? "win32" : "posix",
  );
  const rootResolver = new ReadOnlyRootPathResolver(canonicalizer, boundary);
  const organization = new SqliteOrganizationStore({
    databasePath: paths.organizationDatabase,
  });
  const intelligence = new SqliteIntelligenceStore({
    databasePath: paths.inventoryDatabase,
  });
  const transfers = new SqliteTransferStore(paths.transfersDatabase);
  const enrollments = new JsonlRootEnrollmentStore(paths.enrollmentsJournal);
  const rootGuard = new InventoryRootGuard(
    enrollments,
    canonicalizer,
    new SystemVolumeIdentityProvider(),
    rootResolver,
  );
  const transferGuard = new TransferRootGuard(
    enrollments,
    canonicalizer,
    new SystemVolumeIdentityProvider(),
    rootResolver,
    boundary,
  );
  const worker = new PersistentLocalWorker({
    id: `local-worker-${process.pid}` as WorkerId,
    queue,
    handlers: [
      new DiagnosticCountJobHandler(),
      new InventoryScanJobHandler(rootGuard, catalog),
      new DuplicateCandidateJobHandler(intelligence),
      new ContentHashJobHandler(rootGuard, rootResolver, intelligence),
      new MetadataAnalysisJobHandler(rootGuard, rootResolver, intelligence),
      new RelationshipAnalysisJobHandler(rootGuard, intelligence),
      new ReconciliationJobHandler(intelligence),
      new IngestAnalysisJobHandler(transferGuard, transfers, intelligence),
      new IngestTransferJobHandler(
        transferGuard, transfers, organization, enrollments, intelligence, queue,
      ),
      new CrossVolumeTransferJobHandler(
        transferGuard, transfers, organization, enrollments, intelligence, queue,
      ),
      new QuarantineExecutionJobHandler(
        transferGuard, transfers, organization, enrollments, intelligence, queue,
      ),
      new QuarantineRestoreJobHandler(
        transferGuard, transfers, organization, enrollments,
      ),
      new OrganizationExecutionJobHandler(
        rootGuard,
        organization,
        canonicalizer,
        rootResolver,
        boundary,
      ),
      new OrganizationRollbackJobHandler(
        rootGuard,
        organization,
        canonicalizer,
        rootResolver,
        boundary,
      ),
    ],
  });
  const heartbeat = new WorkerHeartbeat(
    new WorkerStatusStore(paths.workerStatus),
    worker.id,
    process.pid,
  );
  const stop = (): void => worker.requestStop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await heartbeat.start();
    if (mode === "--once") {
      process.stdout.write(`${JSON.stringify({ outcome: await worker.runOnce() })}\n`);
    } else if (mode === undefined) {
      process.stdout.write(`${JSON.stringify({ workerId: worker.id, status: "started" })}\n`);
      await worker.runUntilStopped();
    } else {
      throw new Error(`Unknown worker option: ${mode}`);
    }
  } finally {
    await heartbeat.stop();
    organization.close();
    transfers.close();
    intelligence.close();
    catalog.close();
    queue.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
