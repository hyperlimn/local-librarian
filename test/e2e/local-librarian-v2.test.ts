import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteInventoryCatalog } from "../../src/catalog/index.js";
import type {
  ApprovedLibraryRoot,
  InventoryScanId,
  WorkerId,
} from "../../src/domain/index.js";
import {
  JsonlRootEnrollmentStore,
  RootEnrollmentService,
} from "../../src/enrollment/index.js";
import type { ApprovedIngestSource } from "../../src/ingest/index.js";
import {
  AnalysisService,
  CONTENT_HASH_JOB_DEFINITION,
  ContentHashJobHandler,
  DUPLICATE_DETECTION_JOB_DEFINITION,
  DuplicateCandidateJobHandler,
  METADATA_ANALYSIS_JOB_DEFINITION,
  MetadataAnalysisJobHandler,
  RECONCILIATION_JOB_DEFINITION,
  RELATIONSHIP_ANALYSIS_JOB_DEFINITION,
  ReconciliationJobHandler,
  RelationshipAnalysisJobHandler,
  ScalableReconciliationService,
  SqliteIntelligenceStore,
} from "../../src/intelligence/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../../src/jobs/index.js";
import { InventoryTools } from "../../src/mcp/index.js";
import {
  ORGANIZATION_EXECUTE_JOB_DEFINITION,
  ORGANIZATION_ROLLBACK_JOB_DEFINITION,
  OrganizationExecutionJobHandler,
  OrganizationPlannerService,
  OrganizationRollbackJobHandler,
  OrganizationService,
  SqliteOrganizationStore,
} from "../../src/organization/index.js";
import {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
} from "../../src/safety/index.js";
import {
  INVENTORY_SCAN_JOB_DEFINITION,
  InventoryRootGuard,
  InventoryScanJobHandler,
} from "../../src/scanner/index.js";
import {
  INGEST_ANALYSIS_JOB_DEFINITION,
  INGEST_TRANSFER_JOB_DEFINITION,
  QUARANTINE_EXECUTE_JOB_DEFINITION,
  QUARANTINE_RESTORE_JOB_DEFINITION,
  IngestAnalysisJobHandler,
  IngestTransferJobHandler,
  QuarantineExecutionJobHandler,
  QuarantineRestoreJobHandler,
  SqliteTransferStore,
  TransferRootGuard,
  TransferService,
} from "../../src/transfer/index.js";
import { TestVolumeIdentityProvider } from "../inventory/test-helpers.js";

interface DemonstrationHarness {
  readonly directory: string;
  readonly libraryPath: string;
  readonly ingestPath: string;
  readonly library: ApprovedLibraryRoot;
  readonly ingestSource: ApprovedIngestSource;
  readonly enrollment: RootEnrollmentService;
  readonly catalog: SqliteInventoryCatalog;
  readonly intelligence: SqliteIntelligenceStore;
  readonly organizationStore: SqliteOrganizationStore;
  readonly organization: OrganizationService;
  readonly transfers: SqliteTransferStore;
  readonly transferService: TransferService;
  readonly reconciliation: ScalableReconciliationService;
  readonly queue: SqlitePersistentJobQueue;
  readonly worker: PersistentLocalWorker;
  readonly inventory: InventoryTools;
  readonly analysis: AnalysisService;
  cleanup(): Promise<void>;
}

const harnesses: DemonstrationHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("Local Librarian 2.0 end-to-end demonstration", () => {
  it("understands, organizes, consolidates, restores, ingests, and reconciles a temporary messy library", async () => {
    const harness = await createTrackedHarness();
    const duplicateBytes = Buffer.alloc(4_096, 0x49);
    await mkdir(path.join(harness.libraryPath, "project", "src"), { recursive: true });
    await Promise.all([
      writeFile(path.join(harness.libraryPath, "IMG_001.jpg"), duplicateBytes),
      writeFile(path.join(harness.libraryPath, "IMG_001 copy.jpg"), duplicateBytes),
      writeFile(path.join(harness.libraryPath, "vacation.mov"), "video fixture", "utf8"),
      writeFile(path.join(harness.libraryPath, "taxes.pdf"), "%PDF-1.4\n/Type /Page\n", "utf8"),
      writeFile(path.join(harness.libraryPath, "random.zip"), "PK\u0003\u0004archive", "utf8"),
      writeFile(path.join(harness.libraryPath, "song.mp3"), "ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000", "utf8"),
      writeFile(path.join(harness.libraryPath, "project", "package.json"), "{\"name\":\"fixture\"}", "utf8"),
      writeFile(path.join(harness.libraryPath, "project", "README.md"), "# Fixture project\n", "utf8"),
      writeFile(path.join(harness.libraryPath, "project", "src", "index.ts"), "export const ready = true;\n", "utf8"),
      writeFile(path.join(harness.libraryPath, "loose-code.ts"), "export const loose = true;\n", "utf8"),
      writeFile(path.join(harness.libraryPath, "mystery.foo"), "unrecognized fixture", "utf8"),
    ]);

    const baselineScanId = await scan(harness, "v2-demo-baseline");
    const submittedAnalysis = await harness.analysis.start({
      rootId: harness.library.id,
      requestedBy: "e2e-user",
    });
    expect(submittedAnalysis.jobs.map((job) => job.stage)).toEqual([
      "candidate-duplicates",
      "content-identity",
      "metadata",
      "relationships",
    ]);
    for (const _job of submittedAnalysis.jobs) {
      expect(await harness.worker.runOnce()).toBe("worked");
    }

    const status = await harness.intelligence.analysisStatus(
      harness.library.id,
      baselineScanId,
    );
    expect(status.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "content-identity", status: "completed" }),
      expect.objectContaining({ stage: "metadata", status: "completed" }),
      expect.objectContaining({ stage: "classification", status: "completed" }),
      expect.objectContaining({ stage: "relationships", status: "completed" }),
    ]));
    const exact = await harness.intelligence.duplicateGroups({
      rootId: harness.library.id,
      kind: "exact",
    });
    const duplicateGroup = exact.items.find((group) => group.byteLength === duplicateBytes.byteLength);
    expect(duplicateGroup).toMatchObject({
      copyCount: 2,
      reclaimableBytes: duplicateBytes.byteLength,
      verificationState: "verified",
    });
    expect(await harness.intelligence.semanticGroups(
      harness.library.id,
      baselineScanId,
      "project",
    )).toEqual([
      expect.objectContaining({ relativeRoot: "project", memberCount: 3 }),
    ]);
    expect((await harness.intelligence.needsReview({
      scanId: baselineScanId,
      status: "open",
    })).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "duplicate-keeper-uncertain" }),
      expect.objectContaining({ reason: "unsupported-format", title: expect.stringContaining("mystery.foo") }),
    ]));

    const plan = await harness.organization.createPlan({
      rootId: harness.library.id,
      philosophy: "deep",
      strategy: "category",
      scope: "all-files",
      targetDirectory: "Organized",
      createdBy: "e2e-user",
    });
    expect(plan.counts.plannedMoves).toBeGreaterThan(0);
    expect(plan.counts.preservedCoherentGroups).toBeGreaterThanOrEqual(3);
    expect(plan.counts.needsReviewExcluded).toBeGreaterThanOrEqual(3);
    expect((await harness.organization.listOperations(plan.id)).items.some(
      (operation) => operation.sourceRelativePath.startsWith("project/"),
    )).toBe(false);

    const simulation = await harness.organization.startRun({
      planId: plan.id,
      mode: "simulation",
      approvedBy: "e2e-user",
      confirmation: "SIMULATE",
    });
    expect(await harness.worker.runOnce()).toBe("worked");
    expect(await harness.organization.getRun(simulation.id)).toMatchObject({
      status: "completed",
      counts: { succeeded: plan.counts.plannedMoves },
    });
    await expect(readFile(path.join(harness.libraryPath, "taxes.pdf"), "utf8"))
      .resolves.toContain("%PDF");
    expect(await exists(path.join(harness.libraryPath, "Organized"))).toBe(false);

    await harness.organization.setMutationMode(
      "live",
      "e2e-user",
      "ENABLE LIVE FILE MUTATION",
    );
    await harness.enrollment.setLibraryWriteAccess(
      harness.library.id,
      true,
      "e2e-user",
    );
    const liveRun = await harness.organization.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "e2e-user",
      confirmation: `APPLY ${plan.counts.plannedMoves} FILE MOVES`,
    });
    expect(await harness.worker.runOnce()).toBe("worked");
    expect(await harness.organization.getRun(liveRun.id)).toMatchObject({
      status: "completed",
      counts: { succeeded: plan.counts.plannedMoves, failed: 0, skipped: 0 },
    });
    await expect(readFile(path.join(harness.libraryPath, "project", "package.json"), "utf8"))
      .resolves.toContain("fixture");
    expect(await exists(path.join(harness.libraryPath, "Organized", "Documents", "taxes.pdf")))
      .toBe(true);

    const members = await harness.intelligence.duplicateMembers(duplicateGroup!.id);
    const keeper = members.items.find((member) => member.relativePath === "IMG_001.jpg");
    expect(keeper).toBeDefined();
    await harness.intelligence.decideDuplicateGroup(
      duplicateGroup!.id,
      [keeper!.recordId],
      false,
      new Date().toISOString(),
    );
    const consolidation = await harness.transferService.createDuplicateConsolidation(
      duplicateGroup!.id,
      "e2e-user",
    );
    expect(consolidation.counts.ready).toBe(1);
    await harness.transferService.approve(
      consolidation.id,
      "e2e-user",
      "QUARANTINE 1 DUPLICATE COPIES",
    );
    expect(await harness.worker.runOnce()).toBe("worked");
    const duplicateQuarantine = (await harness.transfers.quarantine({
      status: "active",
    })).items.find((item) => item.reason === "duplicate-consolidation");
    expect(duplicateQuarantine).toMatchObject({
      originalRelativePath: "IMG_001 copy.jpg",
      status: "active",
    });
    expect(await exists(path.join(harness.libraryPath, "IMG_001 copy.jpg"))).toBe(false);
    await harness.transferService.restore(
      duplicateQuarantine!.id,
      "e2e-user",
      "RESTORE IMG_001 copy.jpg",
    );
    expect(await harness.worker.runOnce()).toBe("worked");
    await expect(readFile(path.join(harness.libraryPath, "IMG_001 copy.jpg")))
      .resolves.toEqual(duplicateBytes);

    await writeFile(path.join(harness.ingestPath, "camera-new.jpg"), "unique camera payload", "utf8");
    await harness.enrollment.setIngestSourceRetirementAccess(
      harness.ingestSource.id,
      true,
      true,
      "e2e-user",
    );
    const ingestPlan = await harness.transferService.createIngestPlan({
      sourceRootId: harness.ingestSource.id,
      destinationRootId: harness.library.id,
      targetDirectory: "Imported",
      retireSource: true,
      requestedBy: "e2e-user",
    });
    expect(await harness.worker.runOnce()).toBe("worked");
    expect(await harness.transfers.plan(ingestPlan.id)).toMatchObject({
      status: "ready-for-approval",
      counts: { ready: 1, needsReview: 0 },
    });
    await harness.transferService.approve(
      ingestPlan.id,
      "e2e-user",
      "IMPORT 1 FILES AND QUARANTINE SOURCES",
    );
    expect(await harness.worker.runOnce()).toBe("worked");
    await expect(readFile(path.join(
      harness.libraryPath,
      "Imported",
      "Images",
      "camera-new.jpg",
    ), "utf8")).resolves.toBe("unique camera payload");
    expect(await harness.transfers.receiptForPlan(ingestPlan.id)).toMatchObject({
      formatVersion: 2,
      status: "completed",
    });
    const ingestQuarantine = (await harness.transfers.quarantine({
      status: "active",
    })).items.find((item) => item.reason === "verified-source-retirement");
    expect(ingestQuarantine).toBeDefined();
    await harness.transferService.restore(
      ingestQuarantine!.id,
      "e2e-user",
      "RESTORE camera-new.jpg",
    );
    expect(await harness.worker.runOnce()).toBe("worked");
    await expect(readFile(path.join(harness.ingestPath, "camera-new.jpg"), "utf8"))
      .resolves.toBe("unique camera payload");

    // Successful transfer queues a destination inventory refresh. Run that
    // durable job, then reconcile the original snapshot against the new one.
    expect(await harness.worker.runOnce()).toBe("worked");
    const latest = (await harness.catalog.summary(harness.library.id)).latestScan;
    expect(latest).toMatchObject({ status: "completed" });
    expect(latest?.id).not.toBe(baselineScanId);
    const reconciliation = await harness.reconciliation.compare({
      rootId: harness.library.id,
      baselineScanId,
      comparisonScanId: latest!.id,
      requestedBy: "e2e-user",
    });
    expect(await harness.worker.runOnce()).toBe("worked");
    expect(await harness.reconciliation.get(reconciliation.id)).toMatchObject({
      status: "completed",
      counts: {
        added: expect.any(Number),
        missing: expect.any(Number),
      },
    });
    const completedReconciliation = await harness.reconciliation.get(reconciliation.id);
    expect((completedReconciliation?.counts.added ?? 0) + (completedReconciliation?.counts.missing ?? 0))
      .toBeGreaterThan(0);
    expect(await harness.organization.verifyAuditIntegrity()).toMatchObject({ valid: true });
  });
});

async function createTrackedHarness(): Promise<DemonstrationHarness> {
  const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-v2-e2e-"));
  const libraryPath = path.join(directory, "Messy Library");
  const ingestPath = path.join(directory, "Camera Source");
  const statePath = path.join(directory, "state");
  await Promise.all([
    mkdir(libraryPath, { recursive: true }),
    mkdir(ingestPath, { recursive: true }),
    mkdir(statePath, { recursive: true }),
  ]);
  const enrollmentStore = new JsonlRootEnrollmentStore(
    path.join(statePath, "enrollments.jsonl"),
  );
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  const volumes = new TestVolumeIdentityProvider();
  const enrollment = new RootEnrollmentService(canonicalizer, volumes, enrollmentStore);
  const libraryProposal = await enrollment.propose({
    role: "library",
    path: libraryPath,
    displayName: "Messy Library",
  });
  const ingestProposal = await enrollment.propose({
    role: "ingest-source",
    path: ingestPath,
    displayName: "Camera Source",
    ingestSourceKind: "sd-card",
  });
  const approvedLibrary = await enrollment.approve(libraryProposal.proposalId, "e2e-user");
  const approvedIngest = await enrollment.approve(ingestProposal.proposalId, "e2e-user");
  if (!("controlDirectory" in approvedLibrary.policy)) throw new Error("Expected a library root.");
  if ("controlDirectory" in approvedIngest.policy) throw new Error("Expected an ingest source.");
  const library = approvedLibrary as ApprovedLibraryRoot;
  const ingestSource = approvedIngest as ApprovedIngestSource;

  const catalog = new SqliteInventoryCatalog({
    databasePath: path.join(statePath, "inventory.sqlite"),
  });
  const intelligence = new SqliteIntelligenceStore({
    databasePath: path.join(statePath, "inventory.sqlite"),
  });
  const organizationStore = new SqliteOrganizationStore({
    databasePath: path.join(statePath, "organization.sqlite"),
  });
  const transfers = new SqliteTransferStore(path.join(statePath, "transfers.sqlite"));
  const queue = new SqlitePersistentJobQueue({
    databasePath: path.join(statePath, "jobs.sqlite"),
    definitions: [
      INVENTORY_SCAN_JOB_DEFINITION,
      DUPLICATE_DETECTION_JOB_DEFINITION,
      CONTENT_HASH_JOB_DEFINITION,
      METADATA_ANALYSIS_JOB_DEFINITION,
      RELATIONSHIP_ANALYSIS_JOB_DEFINITION,
      ORGANIZATION_EXECUTE_JOB_DEFINITION,
      ORGANIZATION_ROLLBACK_JOB_DEFINITION,
      RECONCILIATION_JOB_DEFINITION,
      INGEST_ANALYSIS_JOB_DEFINITION,
      INGEST_TRANSFER_JOB_DEFINITION,
      QUARANTINE_EXECUTE_JOB_DEFINITION,
      QUARANTINE_RESTORE_JOB_DEFINITION,
    ],
  });
  const boundary = new PathBoundary(process.platform === "win32" ? "win32" : "posix");
  const rootResolver = new ReadOnlyRootPathResolver(canonicalizer, boundary);
  const rootGuard = new InventoryRootGuard(
    enrollmentStore,
    canonicalizer,
    volumes,
    rootResolver,
  );
  const transferGuard = new TransferRootGuard(
    enrollmentStore,
    canonicalizer,
    volumes,
    rootResolver,
    boundary,
  );
  const worker = new PersistentLocalWorker({
    id: "v2-e2e-worker" as WorkerId,
    queue,
    handlers: [
      new InventoryScanJobHandler(rootGuard, catalog),
      new DuplicateCandidateJobHandler(intelligence),
      new ContentHashJobHandler(rootGuard, rootResolver, intelligence),
      new MetadataAnalysisJobHandler(rootGuard, rootResolver, intelligence),
      new RelationshipAnalysisJobHandler(rootGuard, intelligence),
      new OrganizationExecutionJobHandler(
        rootGuard,
        organizationStore,
        canonicalizer,
        rootResolver,
        boundary,
      ),
      new OrganizationRollbackJobHandler(
        rootGuard,
        organizationStore,
        canonicalizer,
        rootResolver,
        boundary,
      ),
      new ReconciliationJobHandler(intelligence),
      new IngestAnalysisJobHandler(transferGuard, transfers, intelligence),
      new IngestTransferJobHandler(
        transferGuard,
        transfers,
        organizationStore,
        enrollmentStore,
        intelligence,
        queue,
      ),
      new QuarantineExecutionJobHandler(
        transferGuard,
        transfers,
        organizationStore,
        enrollmentStore,
        intelligence,
        queue,
      ),
      new QuarantineRestoreJobHandler(
        transferGuard,
        transfers,
        organizationStore,
        enrollmentStore,
      ),
    ],
  });
  const organization = new OrganizationService(
    new OrganizationPlannerService(
      catalog,
      enrollmentStore,
      organizationStore,
      () => new Date(),
      process.platform === "win32" ? "win32" : "posix",
      intelligence,
    ),
    organizationStore,
    queue,
    enrollmentStore,
  );
  const transferService = new TransferService(
    transfers,
    queue,
    enrollmentStore,
    organizationStore,
    catalog,
    intelligence,
  );
  const harness: DemonstrationHarness = {
    directory,
    libraryPath,
    ingestPath,
    library,
    ingestSource,
    enrollment,
    catalog,
    intelligence,
    organizationStore,
    organization,
    transfers,
    transferService,
    reconciliation: new ScalableReconciliationService(intelligence, queue),
    queue,
    worker,
    inventory: new InventoryTools(queue, enrollmentStore, catalog),
    analysis: new AnalysisService(catalog, enrollmentStore, queue, intelligence),
    cleanup: async () => {
      transfers.close();
      organizationStore.close();
      intelligence.close();
      catalog.close();
      queue.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

async function scan(
  harness: DemonstrationHarness,
  idempotencyKey: string,
): Promise<InventoryScanId> {
  const submitted = await harness.inventory.scan({
    rootId: harness.library.id,
    idempotencyKey,
    requestedBy: "e2e-user",
  });
  expect(await harness.worker.runOnce()).toBe("worked");
  const inventoryScan = await harness.catalog.getScanByJob(submitted.jobId);
  if (inventoryScan === undefined) throw new Error("The demonstration scan was not persisted.");
  return inventoryScan.id;
}

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}
