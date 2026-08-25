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
import { WindowsDriveDiscovery } from "./drive-discovery.js";
import { LocalWebServer } from "./local-web-server.js";
import { LocalWorkerProcessManager } from "./worker-process-manager.js";

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
      ],
    });
    this.#catalog = new SqliteInventoryCatalog({
      databasePath: paths.inventoryDatabase,
    });
    this.#organization = new SqliteOrganizationStore({
      databasePath: paths.organizationDatabase,
    });
    const enrollments = new JsonlRootEnrollmentStore(paths.enrollmentsJournal);
    const canonicalizer = new ReadOnlyCanonicalPathResolver();
    const enrollmentService = new RootEnrollmentService(
      canonicalizer,
      new SystemVolumeIdentityProvider(),
      enrollments,
    );
    const organization = new OrganizationService(
      new OrganizationPlannerService(this.#catalog, enrollments, this.#organization),
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
      new WindowsDriveDiscovery(),
      this.#worker,
      paths,
      "1.0.0",
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
    this.#catalog.close();
    this.#jobs.close();
  }
}
