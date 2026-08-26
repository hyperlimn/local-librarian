import { randomUUID } from "node:crypto";

import type {
  InventoryRecordId,
  InventoryScanId,
  IngestSourceId,
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
import type {
  CreateOrganizationPlanInput,
  OrganizationService,
  StartOrganizationRollbackInput,
  StartOrganizationRunInput,
} from "../organization/index.js";
import type { LocalStatePaths } from "../cli/local-state.js";
import { ReconciliationService } from "../reconciliation/index.js";
import type { DiscoveredVolume, DriveDiscovery } from "./drive-discovery.js";
import type { WorkerManager } from "./worker-process-manager.js";
import {
  type AnalysisService,
  type DuplicateGroupQuery,
  type EnrichedInventoryQuery,
  type NeedsReviewQuery,
  type ReconciliationDeltaKind,
  type ResourceSettings,
  type ScalableReconciliationService,
  type SqliteIntelligenceStore,
} from "../intelligence/index.js";
import type {
  CreateCrossVolumePlanInput,
  CreateIngestPlanInput,
  SqliteTransferStore,
  TransferService,
} from "../transfer/index.js";

export interface WebJobStore extends JobClient {
  list(query?: JobListQuery): Promise<JobRecordPage>;
  get(jobId: JobId): Promise<PersistentJobRecord | undefined>;
}

export interface EnrollmentProposalInput {
  readonly path: string;
  readonly displayName: string;
}

export interface LocalLibrarianV2Services {
  readonly intelligence: SqliteIntelligenceStore;
  readonly analysis: AnalysisService;
  readonly reconciliation: ScalableReconciliationService;
  readonly transfers: SqliteTransferStore;
  readonly transferService: TransferService;
}

export interface LibraryView {
  readonly root: Awaited<ReturnType<RootEnrollmentStore["list"]>>[number];
  readonly summary: Awaited<ReturnType<InventoryCatalog["summary"]>>;
}

export class LocalLibrarianApplication {
  readonly #inventory: InventoryTools;
  readonly #reconciliation: ReconciliationService;
  readonly #intelligence: SqliteIntelligenceStore | undefined;
  readonly #analysis: AnalysisService | undefined;
  readonly #scalableReconciliation: ScalableReconciliationService | undefined;
  readonly #transfers: SqliteTransferStore | undefined;
  readonly #transferService: TransferService | undefined;

  public constructor(
    private readonly enrollmentService: RootEnrollmentService,
    private readonly enrollments: RootEnrollmentStore,
    private readonly jobs: WebJobStore,
    private readonly catalog: InventoryCatalog,
    private readonly organization: OrganizationService,
    private readonly drives: DriveDiscovery,
    private readonly worker: WorkerManager,
    private readonly paths: LocalStatePaths,
    private readonly version = "2.0.0",
    v2?: LocalLibrarianV2Services,
  ) {
    this.#inventory = new InventoryTools(jobs, enrollments, catalog);
    this.#reconciliation = new ReconciliationService(catalog);
    this.#intelligence = v2?.intelligence;
    this.#analysis = v2?.analysis;
    this.#scalableReconciliation = v2?.reconciliation;
    this.#transfers = v2?.transfers;
    this.#transferService = v2?.transferService;
  }

  public async dashboard(): Promise<{
    readonly libraries: readonly LibraryView[];
    readonly activeJobs: readonly PersistentJobRecord[];
    readonly recentJobs: readonly PersistentJobRecord[];
    readonly recentScans: Awaited<ReturnType<InventoryCatalog["listScans"]>>["items"];
    readonly recentPlans: Awaited<ReturnType<OrganizationService["listPlans"]>>["items"];
    readonly recentRuns: Awaited<ReturnType<OrganizationService["listRuns"]>>["items"];
    readonly worker: Awaited<ReturnType<WorkerManager["status"]>>;
    readonly intelligence: Awaited<ReturnType<SqliteIntelligenceStore["summary"]>>;
    readonly attention: readonly {
      readonly kind: "job" | "scan" | "organization-run" | "needs-review";
      readonly id: string;
      readonly message: string;
    }[];
    readonly system: Awaited<ReturnType<LocalLibrarianApplication["system"]>>;
  }> {
    const [libraries, jobPage, scanPage, worker, planPage, runPage, system, intelligenceBase, quarantineCount] = await Promise.all([
      this.libraries(true),
      this.jobs.list({ limit: 100 }),
      this.catalog.listScans({ limit: 20 }),
      this.worker.status(),
      this.organization.listPlans(undefined, 12),
      this.organization.listRuns(undefined, 12),
      this.system(),
      this.#intelligence?.summary() ?? Promise.resolve({
        filesAnalyzed: 0,
        filesAwaitingAnalysis: 0,
        candidateDuplicateGroups: 0,
        exactDuplicateGroups: 0,
        reclaimableDuplicateBytes: 0,
        needsReview: 0,
        quarantineCount: 0,
      }),
      this.#transfers?.quarantineCount() ?? Promise.resolve(0),
    ]);
    const intelligence = { ...intelligenceBase, quarantineCount };
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
      ...runPage.items
        .filter((run) => run.status === "failed" || run.status === "partial")
        .map((run) => ({
          kind: "organization-run" as const,
          id: run.id,
          message: run.error?.message ?? `Organization run finished ${run.status}.`,
        })),
      ...(intelligence.needsReview === 0
        ? []
        : [{
            kind: "needs-review" as const,
            id: "needs-review",
            message: `${intelligence.needsReview.toLocaleString()} items need a decision.`,
          }]),
    ];
    return {
      libraries,
      activeJobs,
      recentJobs: jobPage.items.slice(0, 12),
      recentScans: scanPage.items,
      worker,
      intelligence,
      recentPlans: planPage.items,
      recentRuns: runPage.items,
      attention,
      system,
    };
  }

  public async system(): Promise<{
    readonly version: string;
    readonly binding: "loopback-only";
    readonly safetyStatus: "enforced";
    readonly filesystemExecution: "simulation-only" | "live";
    readonly fileMutation: "DISABLED" | "ENABLED";
    readonly mutationMode: Awaited<ReturnType<OrganizationService["mutationMode"]>>;
    readonly capabilities: {
      readonly inventory: true;
      readonly planning: true;
      readonly simulation: true;
      readonly liveRelocation: boolean;
      readonly rollback: true;
      readonly contentIdentity: boolean;
      readonly duplicates: boolean;
      readonly metadataAnalysis: boolean;
      readonly relationships: boolean;
      readonly needsReview: boolean;
      readonly scalableReconciliation: boolean;
      readonly ingest: boolean;
      readonly quarantine: boolean;
      readonly crossVolumeOrganization: boolean;
    };
    readonly databasePaths: {
      readonly jobs: string;
      readonly inventory: string;
      readonly organization: string;
      readonly enrollments: string;
      readonly workerStatus: string;
      readonly transfers: string;
    };
  }> {
    const mutationMode = await this.organization.mutationMode();
    const live = mutationMode.mode === "live";
    return {
      version: this.version,
      binding: "loopback-only",
      safetyStatus: "enforced",
      filesystemExecution: live ? "live" : "simulation-only",
      fileMutation: live ? "ENABLED" : "DISABLED",
      mutationMode,
      capabilities: {
        inventory: true,
        planning: true,
        simulation: true,
        liveRelocation: live,
        rollback: true,
        contentIdentity: this.#intelligence !== undefined,
        duplicates: this.#intelligence !== undefined,
        metadataAnalysis: this.#analysis !== undefined,
        relationships: this.#analysis !== undefined,
        needsReview: this.#intelligence !== undefined,
        scalableReconciliation: this.#scalableReconciliation !== undefined,
        ingest: this.#transferService !== undefined,
        quarantine: this.#transferService !== undefined,
        crossVolumeOrganization: this.#transferService !== undefined,
      },
      databasePaths: {
        jobs: this.paths.jobsDatabase,
        inventory: this.paths.inventoryDatabase,
        organization: this.paths.organizationDatabase,
        enrollments: this.paths.enrollmentsJournal,
        workerStatus: this.paths.workerStatus,
        transfers: this.paths.transfersDatabase,
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

  public proposeIngestSource(input: EnrollmentProposalInput & {
    readonly ingestSourceKind: "folder" | "drive" | "sd-card" | "drop-directory";
  }): Promise<RootEnrollmentProposal> {
    return this.enrollmentService.propose({
      role: "ingest-source",
      path: input.path,
      displayName: input.displayName,
      ingestSourceKind: input.ingestSourceKind,
    });
  }

  public async ingestSources(includeRevoked = true) {
    return this.enrollments.list({ role: "ingest-source", includeRevoked });
  }

  public approveEnrollment(proposalId: string, approvedBy: string) {
    return this.enrollmentService.approve(proposalId, approvedBy);
  }

  public revokeEnrollment(rootId: EnrolledRootId, reason: string) {
    return this.enrollmentService.revoke(rootId, reason);
  }
  public setLibraryWriteAccess(
    rootId: LibraryRootId,
    allowWrites: boolean,
    approvedBy: string,
  ) {
    return this.enrollmentService.setLibraryWriteAccess(
      rootId,
      allowWrites,
      approvedBy,
    );
  }

  public setIngestSourceRetirementAccess(
    rootId: IngestSourceId,
    allowWrites: boolean,
    allowSourceRetirement: boolean,
    approvedBy: string,
  ) {
    return this.enrollmentService.setIngestSourceRetirementAccess(
      rootId,
      allowWrites,
      allowSourceRetirement,
      approvedBy,
    );
  }

  public setMutationMode(
    mode: "read-only" | "live",
    updatedBy: string,
    confirmation: string,
  ) {
    return this.organization.setMutationMode(mode, updatedBy, confirmation);
  }

  public createOrganizationPlan(input: CreateOrganizationPlanInput) {
    return this.organization.createPlan(input);
  }

  public organizationPlans(rootId?: LibraryRootId, limit?: number, cursor?: string) {
    return this.organization.listPlans(rootId, limit, cursor);
  }

  public organizationPlan(planId: string) {
    return this.organization.getPlan(planId);
  }

  public organizationOperations(planId: string, limit?: number, cursor?: string) {
    return this.organization.listOperations(planId, limit, cursor);
  }

  public startOrganizationRun(input: StartOrganizationRunInput) {
    return this.organization.startRun(input);
  }

  public organizationRuns(planId?: string, limit?: number, cursor?: string) {
    return this.organization.listRuns(planId, limit, cursor);
  }

  public organizationRun(runId: string) {
    return this.organization.getRun(runId);
  }

  public organizationRunItems(runId: string, limit?: number, cursor?: string) {
    return this.organization.listRunItems(runId, limit, cursor);
  }

  public startOrganizationRollback(input: StartOrganizationRollbackInput) {
    return this.organization.startRollback(input);
  }

  public organizationAudit(limit?: number, cursor?: string) {
    return this.organization.audit(limit, cursor);
  }

  public verifyOrganizationAudit() {
    return this.organization.verifyAuditIntegrity();
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

  public enrichedInventory(rootId: LibraryRootId, query?: EnrichedInventoryQuery) {
    return this.requireIntelligence().enrichedInventory(rootId, query);
  }

  public analysisStatus(rootId: LibraryRootId, scanId?: string) {
    const analysis = this.#analysis;
    if (analysis === undefined) throw new Error("Content analysis is not available in this runtime.");
    return analysis.status(rootId, scanId);
  }

  public startAnalysis(input: {
    readonly rootId: LibraryRootId;
    readonly requestedBy: string;
    readonly stages?: readonly import("../intelligence/index.js").AnalysisStageName[];
    readonly hashScope?: "duplicate-candidates" | "all";
  }) {
    const analysis = this.#analysis;
    if (analysis === undefined) throw new Error("Content analysis is not available in this runtime.");
    return analysis.start(input);
  }

  public duplicates(query?: DuplicateGroupQuery) {
    return this.requireIntelligence().duplicateGroups(query);
  }

  public duplicateGroup(id: string) {
    return this.requireIntelligence().duplicateGroup(id);
  }

  public duplicateMembers(id: string, limit?: number, cursor?: string) {
    return this.requireIntelligence().duplicateMembers(id, limit, cursor);
  }

  public decideDuplicateGroup(
    id: string,
    keeperRecordIds: readonly string[],
    keepEverything: boolean,
  ) {
    return this.requireIntelligence().decideDuplicateGroup(
      id,
      keeperRecordIds,
      keepEverything,
      new Date().toISOString(),
    );
  }

  public needsReview(query?: NeedsReviewQuery) {
    return this.requireIntelligence().needsReview(query);
  }

  public resolveNeedsReview(
    id: string,
    status: "resolved" | "dismissed",
    resolution: import("../domain/index.js").JsonObject,
    rememberExtensionRule: boolean,
  ) {
    return this.requireIntelligence().resolveNeedsReview(
      id,
      status,
      resolution,
      new Date().toISOString(),
      rememberExtensionRule,
    );
  }

  public semanticGroups(rootId: LibraryRootId, scanId?: string) {
    return this.requireIntelligence().semanticGroups(rootId, scanId);
  }

  public resourceSettings() {
    return this.requireIntelligence().settings();
  }

  public saveResourceSettings(settings: ResourceSettings) {
    return this.requireIntelligence().saveSettings(settings, new Date().toISOString());
  }

  public scans(query?: InventoryScanListQuery) {
    return this.catalog.listScans(query);
  }

  public scan(scanId: InventoryScanId) {
    return this.catalog.getScan(scanId);
  }

  public compareScans(
    rootId: LibraryRootId,
    baselineScanId: InventoryScanId,
    comparisonScanId: InventoryScanId,
  ) {
    if (this.#scalableReconciliation !== undefined) {
      return this.#scalableReconciliation.compare({
        rootId,
        baselineScanId,
        comparisonScanId,
        requestedBy: "webui",
      });
    }
    return this.#reconciliation.compare({
      rootId,
      baselineScanId,
      comparisonScanId,
    });
  }

  public reconciliations(rootId?: string, limit?: number, cursor?: string) {
    const service = this.#scalableReconciliation;
    if (service === undefined) throw new Error("Scalable reconciliation is not available in this runtime.");
    return service.list(rootId, limit, cursor);
  }

  public reconciliation(id: string) {
    const service = this.#scalableReconciliation;
    if (service === undefined) throw new Error("Scalable reconciliation is not available in this runtime.");
    return service.get(id);
  }

  public reconciliationDeltas(
    id: string,
    input?: {
      readonly kind?: ReconciliationDeltaKind;
      readonly search?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) {
    const service = this.#scalableReconciliation;
    if (service === undefined) throw new Error("Scalable reconciliation is not available in this runtime.");
    return service.deltas(id, input);
  }

  public createIngestPlan(input: CreateIngestPlanInput) {
    return this.requireTransferService().createIngestPlan(input);
  }

  public createCrossVolumePlan(input: CreateCrossVolumePlanInput) {
    return this.requireTransferService().createCrossVolumePlan(input);
  }

  public createDuplicateConsolidation(groupId: string, requestedBy: string) {
    return this.requireTransferService().createDuplicateConsolidation(groupId, requestedBy);
  }

  public transferPlans(query?: Parameters<TransferService["plans"]>[0]) {
    return this.requireTransferService().plans(query);
  }

  public transferPlan(id: string) { return this.requireTransferService().plan(id); }
  public transferItems(planId: string, query?: Parameters<TransferService["items"]>[1]) {
    return this.requireTransferService().items(planId, query);
  }
  public resolveTransferItem(planId: string, itemId: string, destinationRelativePath: string) {
    return this.requireTransferService().resolveItem(planId, itemId, destinationRelativePath);
  }
  public approveTransferPlan(planId: string, approvedBy: string, confirmation: string) {
    return this.requireTransferService().approve(planId, approvedBy, confirmation);
  }
  public transferReceipt(planId: string) { return this.requireTransferService().receipt(planId); }
  public quarantine(query?: Parameters<TransferService["quarantine"]>[0]) {
    return this.requireTransferService().quarantine(query);
  }
  public quarantineItem(id: string) { return this.requireTransferService().quarantineItem(id); }
  public restoreQuarantine(id: string, approvedBy: string, confirmation: string) {
    return this.requireTransferService().restore(id, approvedBy, confirmation);
  }
  public transferAudit(limit?: number, afterSequence?: number) {
    return this.requireTransferService().audit(limit, afterSequence);
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

  private requireIntelligence(): SqliteIntelligenceStore {
    if (this.#intelligence === undefined) {
      throw new Error("Content intelligence is not available in this runtime.");
    }
    return this.#intelligence;
  }

  private requireTransferService(): TransferService {
    if (this.#transferService === undefined) {
      throw new Error("Verified transfer and quarantine services are not available in this runtime.");
    }
    return this.#transferService;
  }
}

function sameMount(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replaceAll("/", "\\").replace(/\\+$/u, "").toLocaleLowerCase("en-US");
  return normalize(left) === normalize(right);
}
