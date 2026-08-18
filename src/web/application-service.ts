import { randomUUID } from "node:crypto";

import type {
  InventoryRecordId,
  InventoryScanId,
  JobId,
  LibraryRootId,
} from "../domain/index.js";
import type {
  InventoryCatalog,
  InventoryListQuery,
  InventoryScanListQuery,
} from "../catalog/index.js";
import type {
  EnrolledRootId,
  RootEnrollmentProposal,
  RootEnrollmentService,
  RootEnrollmentStore,
} from "../enrollment/index.js";
import type {
  JobClient,
  JobListQuery,
  JobRecordPage,
  PersistentJobRecord,
} from "../jobs/index.js";
import { InventoryTools } from "../mcp/index.js";
import type { LocalStatePaths } from "../cli/local-state.js";
import type { DiscoveredVolume, DriveDiscovery } from "./drive-discovery.js";
import type { WorkerManager } from "./worker-process-manager.js";

export interface WebJobStore extends JobClient {
  list(query?: JobListQuery): Promise<JobRecordPage>;
  get(jobId: JobId): Promise<PersistentJobRecord | undefined>;
}

export interface EnrollmentProposalInput {
  readonly path: string;
  readonly displayName: string;
}

export interface LibraryView {
  readonly root: Awaited<ReturnType<RootEnrollmentStore["list"]>>[number];
  readonly summary: Awaited<ReturnType<InventoryCatalog["summary"]>>;
}

export class LocalLibrarianApplication {
  readonly #inventory: InventoryTools;

  public constructor(
    private readonly enrollmentService: RootEnrollmentService,
    private readonly enrollments: RootEnrollmentStore,
    private readonly jobs: WebJobStore,
    private readonly catalog: InventoryCatalog,
    private readonly drives: DriveDiscovery,
    private readonly worker: WorkerManager,
    private readonly paths: LocalStatePaths,
    private readonly version = "0.0.0",
  ) {
    this.#inventory = new InventoryTools(jobs, enrollments, catalog);
  }

  public async dashboard(): Promise<{
    readonly libraries: readonly LibraryView[];
    readonly activeJobs: readonly PersistentJobRecord[];
    readonly recentJobs: readonly PersistentJobRecord[];
    readonly recentScans: Awaited<ReturnType<InventoryCatalog["listScans"]>>["items"];
    readonly worker: Awaited<ReturnType<WorkerManager["status"]>>;
    readonly attention: readonly {
      readonly kind: "job" | "scan";
      readonly id: string;
      readonly message: string;
    }[];
    readonly system: ReturnType<LocalLibrarianApplication["system"]>;
  }> {
    const [libraries, jobPage, scanPage, worker] = await Promise.all([
      this.libraries(true),
      this.jobs.list({ limit: 100 }),
      this.catalog.listScans({ limit: 20 }),
      this.worker.status(),
    ]);
    const activeStatuses = new Set(["queued", "running", "paused"]);
    const activeJobs = jobPage.items.filter((job) => activeStatuses.has(job.status));
    const attention = [
      ...jobPage.items
        .filter((job) => job.status === "failed")
        .map((job) => ({
          kind: "job" as const,
          id: job.id,
          message: job.error?.message ?? `${job.kind} failed.`,
        })),
      ...scanPage.items
        .filter((scan) => scan.status === "failed")
        .map((scan) => ({
          kind: "scan" as const,
          id: scan.id,
          message: scan.error?.message ?? "Inventory scan failed.",
        })),
    ];
    return {
      libraries,
      activeJobs,
      recentJobs: jobPage.items.slice(0, 12),
      recentScans: scanPage.items,
      worker,
      attention,
      system: this.system(),
    };
  }

  public system(): {
    readonly version: string;
    readonly binding: "loopback-only";
    readonly safetyStatus: "enforced";
    readonly filesystemExecution: "disabled";
    readonly fileMutation: "DISABLED";
    readonly databasePaths: {
      readonly jobs: string;
      readonly inventory: string;
      readonly enrollments: string;
      readonly workerStatus: string;
    };
  } {
    return {
      version: this.version,
      binding: "loopback-only",
      safetyStatus: "enforced",
      filesystemExecution: "disabled",
      fileMutation: "DISABLED",
      databasePaths: {
        jobs: this.paths.jobsDatabase,
        inventory: this.paths.inventoryDatabase,
        enrollments: this.paths.enrollmentsJournal,
        workerStatus: this.paths.workerStatus,
      },
    };
  }

  public async discoveredVolumes(): Promise<readonly (DiscoveredVolume & {
    readonly enrollmentStatus: "not-enrolled" | "enrolled";
    readonly rootId?: string;
    readonly approvalStatus?: string;
  })[]> {
    const [volumes, roots] = await Promise.all([
      this.drives.discover(),
      this.enrollments.list({ role: "library", includeRevoked: true }),
    ]);
    return volumes.map((volume) => {
      const root = roots.find((candidate) =>
        sameMount(candidate.canonicalPath, volume.mountPath),
      );
      return {
        ...volume,
        enrollmentStatus: root === undefined ? "not-enrolled" : "enrolled",
        ...(root === undefined
          ? {}
          : { rootId: root.id, approvalStatus: root.approval.status }),
      };
    });
  }

  public async libraries(includeRevoked = true): Promise<readonly LibraryView[]> {
    const roots = await this.enrollments.list({
      role: "library",
      includeRevoked,
    });
    return Promise.all(roots.map(async (root) => ({
      root,
      summary: await this.catalog.summary(root.id as LibraryRootId),
    })));
  }

  public proposeEnrollment(input: EnrollmentProposalInput): Promise<RootEnrollmentProposal> {
    return this.enrollmentService.propose({
      role: "library",
      path: input.path,
      displayName: input.displayName,
    });
  }

  public approveEnrollment(proposalId: string, approvedBy: string) {
    return this.enrollmentService.approve(proposalId, approvedBy);
  }

  public revokeEnrollment(rootId: EnrolledRootId, reason: string) {
    return this.enrollmentService.revoke(rootId, reason);
  }

  public startScan(rootId: LibraryRootId, requestedBy = "webui") {
    return this.#inventory.scan({
      rootId,
      idempotencyKey: `webui:inventory.scan:${rootId}:${randomUUID()}`,
      requestedBy,
    });
  }

  public inventorySummary(rootId: LibraryRootId) {
    return this.#inventory.summary(rootId);
  }

  public inventoryList(rootId: LibraryRootId, query?: InventoryListQuery) {
    return this.#inventory.list(rootId, query);
  }

  public inventoryGet(recordId: InventoryRecordId) {
    return this.#inventory.get(recordId);
  }

  public scans(query?: InventoryScanListQuery) {
    return this.catalog.listScans(query);
  }

  public scan(scanId: InventoryScanId) {
    return this.catalog.getScan(scanId);
  }

  public jobList(query?: JobListQuery) {
    return this.jobs.list(query);
  }

  public job(jobId: JobId) {
    return this.jobs.get(jobId);
  }

  public jobHistory(jobId: JobId) {
    return this.jobs.history(jobId, 0, 500);
  }

  public jobResult(jobId: JobId) {
    return this.jobs.result(jobId);
  }

  public pauseJob(jobId: JobId) {
    return this.jobs.requestPause(jobId, "webui");
  }

  public resumeJob(jobId: JobId) {
    return this.jobs.resume(jobId, "webui");
  }

  public cancelJob(jobId: JobId) {
    return this.jobs.cancel(jobId, "webui");
  }

  public workerStatus() {
    return this.worker.status();
  }

  public startWorker() {
    return this.worker.start();
  }
}

function sameMount(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replaceAll("/", "\\").replace(/\\+$/u, "").toLocaleLowerCase("en-US");
  return normalize(left) === normalize(right);
}

