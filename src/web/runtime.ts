import { resolve } from "node:path";

import {
  localStatePaths,
  resolveLocalStateDirectory,
} from "../cli/local-state.js";
import { SqliteInventoryCatalog } from "../catalog/index.js";
import {
  JsonlRootEnrollmentStore,
  RootEnrollmentService,
  SystemVolumeIdentityProvider,
} from "../enrollment/index.js";
import {
  DIAGNOSTIC_COUNT_JOB_DEFINITION,
  SqlitePersistentJobQueue,
  WorkerStatusStore,
} from "../jobs/index.js";
import { ReadOnlyCanonicalPathResolver } from "../safety/index.js";
import {
  ORGANIZATION_EXECUTE_JOB_DEFINITION,
  ORGANIZATION_ROLLBACK_JOB_DEFINITION,
  OrganizationPlannerService,
  OrganizationService,
  SqliteOrganizationStore,
} from "../organization/index.js";
import { INVENTORY_SCAN_JOB_DEFINITION } from "../scanner/index.js";
import { LocalApiRouter } from "./api-router.js";
import { LocalLibrarianApplication } from "./application-service.js";
import { SystemDriveDiscovery } from "./drive-discovery.js";
import { LocalWebServer } from "./local-web-server.js";
import { LocalWorkerProcessManager } from "./worker-process-manager.js";
import {
  AnalysisService,
  CONTENT_HASH_JOB_DEFINITION,
  DUPLICATE_DETECTION_JOB_DEFINITION,
  METADATA_ANALYSIS_JOB_DEFINITION,
  RECONCILIATION_JOB_DEFINITION,
  RELATIONSHIP_ANALYSIS_JOB_DEFINITION,
  ScalableReconciliationService,
  SqliteIntelligenceStore,
} from "../intelligence/index.js";
import {
  CROSS_VOLUME_TRANSFER_JOB_DEFINITION,
  INGEST_ANALYSIS_JOB_DEFINITION,
  INGEST_TRANSFER_JOB_DEFINITION,
  QUARANTINE_EXECUTE_JOB_DEFINITION,
  QUARANTINE_RESTORE_JOB_DEFINITION,
  SqliteTransferStore,
  TransferService,
} from "../transfer/index.js";

export interface LocalWebRuntimeOptions {
  readonly stateDirectory?: string;
  readonly staticDirectory?: string;
  readonly port?: number;
  readonly host?: "127.0.0.1" | "::1" | "localhost";
}

export class LocalWebRuntime {
  public readonly server: LocalWebServer;
  public readonly stateDirectory: string;
  readonly #jobs: SqlitePersistentJobQueue;
  readonly #catalog: SqliteInventoryCatalog;
  readonly #worker: LocalWorkerProcessManager;
  readonly #organization: SqliteOrganizationStore;
  readonly #intelligence: SqliteIntelligenceStore;
  readonly #transfers: SqliteTransferStore;

  public constructor(options: LocalWebRuntimeOptions = {}) {
    this.stateDirectory = resolveLocalStateDirectory(options.stateDirectory);
    const paths = localStatePaths(this.stateDirectory);
    this.#jobs = new SqlitePersistentJobQueue({
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
    this.#catalog = new SqliteInventoryCatalog({
      databasePath: paths.inventoryDatabase,
    });
    this.#organization = new SqliteOrganizationStore({
      databasePath: paths.organizationDatabase,
    });
    this.#intelligence = new SqliteIntelligenceStore({
      databasePath: paths.inventoryDatabase,
    });
    this.#transfers = new SqliteTransferStore(paths.transfersDatabase);
    const enrollments = new JsonlRootEnrollmentStore(paths.enrollmentsJournal);
    const canonicalizer = new ReadOnlyCanonicalPathResolver();
    const enrollmentService = new RootEnrollmentService(
      canonicalizer,
      new SystemVolumeIdentityProvider(),
      enrollments,
    );
    const organization = new OrganizationService(
      new OrganizationPlannerService(
        this.#catalog,
        enrollments,
        this.#organization,
        () => new Date(),
        process.platform === "win32" ? "win32" : "posix",
        this.#intelligence,
      ),
      this.#organization,
      this.#jobs,
      enrollments,
    );
    this.#worker = new LocalWorkerProcessManager({
      stateDirectory: this.stateDirectory,
      statusStore: new WorkerStatusStore(paths.workerStatus),
    });
    const application = new LocalLibrarianApplication(
      enrollmentService,
      enrollments,
      this.#jobs,
      this.#catalog,
      organization,
      new SystemDriveDiscovery(),
      this.#worker,
      paths,
      "2.0.0",
      {
        intelligence: this.#intelligence,
        analysis: new AnalysisService(
          this.#catalog,
          enrollments,
          this.#jobs,
          this.#intelligence,
        ),
        reconciliation: new ScalableReconciliationService(
          this.#intelligence,
          this.#jobs,
        ),
        transfers: this.#transfers,
        transferService: new TransferService(
          this.#transfers,
          this.#jobs,
          enrollments,
          this.#organization,
          this.#catalog,
          this.#intelligence,
        ),
      },
    );
    this.server = new LocalWebServer({
      router: new LocalApiRouter(application),
      staticDirectory: resolve(options.staticDirectory ?? "web-dist"),
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4_777,
    });
  }

  /** Ensures queued work is processed without requiring a separate setup step. */
  public startWorker() {
    return this.#worker.start();
  }

  public async close(): Promise<void> {
    await this.server.close();
    this.#organization.close();
    this.#transfers.close();
    this.#intelligence.close();
    this.#catalog.close();
    this.#jobs.close();
  }
}
