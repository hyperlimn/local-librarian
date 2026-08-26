import { createHash } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InventoryScanId, WorkerId } from "../../src/domain/index.js";
import {
  AnalysisService,
  CONTENT_HASH_JOB_DEFINITION,
  DUPLICATE_DETECTION_JOB_DEFINITION,
  DuplicateCandidateJobHandler,
  ContentHashJobHandler,
  METADATA_ANALYSIS_JOB_DEFINITION,
  MetadataAnalysisJobHandler,
  RELATIONSHIP_ANALYSIS_JOB_DEFINITION,
  RelationshipAnalysisJobHandler,
  SqliteIntelligenceStore,
  defaultMetadataAnalyzers,
  type AnalysisStageName,
  type AnalyzerOutcome,
  type HashTask,
  type LocalMetadataAnalyzer,
} from "../../src/intelligence/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../../src/jobs/index.js";
import { InventoryTools } from "../../src/mcp/index.js";
import {
  OrganizationPlannerService,
  SqliteOrganizationStore,
} from "../../src/organization/index.js";
import {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
} from "../../src/safety/index.js";
import {
  INVENTORY_SCAN_JOB_DEFINITION,
  InventoryScanJobHandler,
} from "../../src/scanner/index.js";
import {
  createCatalog,
  createInventoryFixture,
  createRootGuard,
  type InventoryTestFixture,
} from "../inventory/test-helpers.js";

interface Harness {
  readonly fixture: InventoryTestFixture;
  readonly queue: SqlitePersistentJobQueue;
  readonly catalog: ReturnType<typeof createCatalog>;
  readonly intelligence: SqliteIntelligenceStore;
  readonly organization: SqliteOrganizationStore;
  readonly worker: PersistentLocalWorker;
  readonly analysis: AnalysisService;
  scan(key: string): Promise<InventoryScanId>;
  analyze(stages?: readonly AnalysisStageName[]): Promise<InventoryScanId>;
  cleanup(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("progressive content intelligence", () => {
  it("identifies content, isolates analyzers, preserves groups, and reuses only unchanged evidence", async () => {
    const harness = await createTrackedHarness();
    const duplicatePayload = Buffer.alloc(4_096, 0x61);
    const changedPayload = Buffer.alloc(4_096, 0x62);
    const duplicateA = path.join(harness.fixture.rootPath, "duplicate-a.bin");
    const duplicateB = path.join(harness.fixture.rootPath, "duplicate-b.bin");
    const projectRoot = path.join(harness.fixture.rootPath, "project");

    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await Promise.all([
      writeFile(duplicateA, duplicatePayload),
      writeFile(duplicateB, duplicatePayload),
      writeFile(path.join(projectRoot, "package.json"), "{\"name\":\"fixture\"}", "utf8"),
      writeFile(path.join(projectRoot, "README.md"), "# Fixture project", "utf8"),
      writeFile(path.join(projectRoot, "src", "index.ts"), "export const value = 1;\n", "utf8"),
      writeFile(path.join(harness.fixture.rootPath, "mystery.foo"), "unknown fixture", "utf8"),
      writeFile(path.join(harness.fixture.rootPath, "loose-code.ts"), "export const loose = true;\n", "utf8"),
    ]);

    const firstScanId = await harness.scan("content-scan-1");
    await expect(harness.analyze()).resolves.toBe(firstScanId);

    const firstStatus = await harness.intelligence.analysisStatus(
      harness.fixture.root.id,
      firstScanId,
    );
    expect(firstStatus.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "candidate-duplicates", status: "completed" }),
      expect.objectContaining({ stage: "content-identity", status: "completed" }),
      expect.objectContaining({ stage: "metadata", status: "completed" }),
      expect.objectContaining({ stage: "classification", status: "completed" }),
      expect.objectContaining({ stage: "relationships", status: "completed" }),
    ]));

    const exactGroups = await harness.intelligence.duplicateGroups({
      rootId: harness.fixture.root.id,
      kind: "exact",
      minimumReclaimableBytes: 4_096,
    });
    const duplicateGroup = exactGroups.items.find((group) => group.byteLength === 4_096);
    expect(duplicateGroup).toMatchObject({
      copyCount: 2,
      totalBytes: 8_192,
      reclaimableBytes: 4_096,
      verificationState: "verified",
    });
    const duplicateMembers = await harness.intelligence.duplicateMembers(duplicateGroup!.id);
    expect(duplicateMembers.items.map((member) => member.relativePath)).toEqual([
      "duplicate-a.bin",
      "duplicate-b.bin",
    ]);

    const firstRecords = await recordsByPath(harness, firstScanId);
    const hashA = await harness.intelligence.hashForRecord(firstRecords.get("duplicate-a.bin")!.id);
    const hashB = await harness.intelligence.hashForRecord(firstRecords.get("duplicate-b.bin")!.id);
    const expectedDigest = createHash("sha256").update(duplicatePayload).digest("hex");
    expect(hashA).toMatchObject({
      algorithm: "sha256",
      digestHex: expectedDigest,
      byteLength: 4_096,
      verificationState: "verified",
    });
    expect(hashB?.digestHex).toBe(expectedDigest);

    const projects = await harness.intelligence.semanticGroups(
      harness.fixture.root.id,
      firstScanId,
      "project",
    );
    expect(projects).toEqual([
      expect.objectContaining({
        relativeRoot: "project",
        provenance: "deterministic",
        memberCount: 3,
      }),
    ]);

    const failureReviews = await harness.intelligence.needsReview({
      scanId: firstScanId,
      reason: "analysis-failed",
    });
    const analyzerFailure = failureReviews.items.find((item) =>
      item.title.includes("mystery.foo")
    );
    expect(analyzerFailure?.description).toContain("fixture-failure");
    await harness.intelligence.resolveNeedsReview(
      analyzerFailure!.id,
      "dismissed",
      { reason: "known fixture analyzer limitation" },
      new Date().toISOString(),
    );
    await harness.intelligence.createNeedsReview(analyzerFailure!);
    expect((await harness.intelligence.needsReview({
      scanId: firstScanId,
      status: "dismissed",
    })).items.some((item) => item.id === analyzerFailure!.id)).toBe(true);

    const unsupported = (await harness.intelligence.needsReview({
      scanId: firstScanId,
      reason: "unsupported-format",
    })).items.find((item) => item.title.includes("mystery.foo"));
    await harness.intelligence.resolveNeedsReview(
      unsupported!.id,
      "resolved",
      { category: "Design" },
      new Date().toISOString(),
      true,
    );
    await harness.intelligence.createNeedsReview(unsupported!);
    expect(await harness.intelligence.classificationRule("foo")).toBe("Design");
    expect((await harness.intelligence.needsReview({
      scanId: firstScanId,
      status: "resolved",
    })).items.some((item) => item.id === unsupported!.id)).toBe(true);

    const planner = new OrganizationPlannerService(
      harness.catalog,
      harness.fixture.store,
      harness.organization,
      () => new Date(),
      process.platform === "win32" ? "win32" : "posix",
      harness.intelligence,
    );
    const plan = await planner.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      philosophy: "deep",
      scope: "all-files",
      targetDirectory: "Organized",
      createdBy: "test-user",
    });
    expect(plan.counts.preservedCoherentGroups).toBe(3);
    expect(plan.counts.needsReviewExcluded).toBeGreaterThanOrEqual(3);
    const operations = await harness.organization.listOperations(plan.id);
    expect(operations.items.map((operation) => operation.sourceRelativePath)).toEqual([
      "loose-code.ts",
    ]);
    expect(operations.items.some((operation) =>
      operation.sourceRelativePath.startsWith("project/")
    )).toBe(false);

    const exactInventory = await harness.intelligence.enrichedInventory(
      harness.fixture.root.id,
      { scanId: firstScanId, duplicateState: "exact", limit: 1 },
    );
    expect(exactInventory.items).toHaveLength(1);
    expect(exactInventory.nextCursor).toBeDefined();
    const exactInventoryPageTwo = await harness.intelligence.enrichedInventory(
      harness.fixture.root.id,
      {
        scanId: firstScanId,
        duplicateState: "exact",
        limit: 1,
        cursor: exactInventory.nextCursor!,
      },
    );
    expect(exactInventoryPageTwo.items).toHaveLength(1);
    expect(exactInventoryPageTwo.items[0]?.recordId).not.toBe(exactInventory.items[0]?.recordId);

    const secondScanId = await harness.scan("content-scan-2");
    await harness.analyze(["content-identity", "metadata"]);
    const secondRecords = await recordsByPath(harness, secondScanId);
    for (const relativePath of ["duplicate-a.bin", "duplicate-b.bin"]) {
      const observation = await harness.intelligence.hashForRecord(
        secondRecords.get(relativePath)!.id,
      );
      expect(observation).toMatchObject({
        digestHex: expectedDigest,
        verificationState: "reused",
      });
      expect(observation?.reusedFromRecordId).toBeDefined();
    }
    const metadataStage = (await harness.intelligence.stages(
      harness.fixture.root.id,
      secondScanId,
    )).find((stage) => stage.stage === "metadata");
    expect(metadataStage?.details["reusedAnalyzerResults"]).toEqual(expect.any(Number));
    expect(Number(metadataStage?.details["reusedAnalyzerResults"])).toBeGreaterThan(0);

    await writeFile(duplicateB, changedPayload);
    const future = new Date(Date.now() + 10_000);
    await utimes(duplicateB, future, future);
    const thirdScanId = await harness.scan("content-scan-3");
    await harness.analyze(["content-identity"]);
    const thirdRecords = await recordsByPath(harness, thirdScanId);
    expect(await harness.intelligence.hashForRecord(
      thirdRecords.get("duplicate-a.bin")!.id,
    )).toMatchObject({
      digestHex: expectedDigest,
      verificationState: "reused",
    });
    expect(await harness.intelligence.hashForRecord(
      thirdRecords.get("duplicate-b.bin")!.id,
    )).toMatchObject({
      digestHex: createHash("sha256").update(changedPayload).digest("hex"),
      verificationState: "verified",
    });
    const thirdExact = await harness.intelligence.duplicateGroups({
      rootId: harness.fixture.root.id,
      kind: "exact",
    });
    expect(thirdExact.items.some((group) =>
      group.scanId === thirdScanId && group.byteLength === 4_096
    )).toBe(false);

    const currentSettings = await harness.intelligence.settings();
    await harness.intelligence.saveSettings(
      { ...currentSettings, analysisDepth: "deep" },
      new Date().toISOString(),
    );
    const preferredSubmission = await harness.analysis.start({
      rootId: harness.fixture.root.id,
      requestedBy: "test-user",
    });
    const preferredHashJobId = preferredSubmission.jobs.find(
      (job) => job.stage === "content-identity",
    )?.receipt.jobId;
    expect(preferredHashJobId).toBeDefined();
    expect((await harness.queue.get(preferredHashJobId!))?.payload["scope"]).toBe("all");
  });
});

class FixtureFailureAnalyzer implements LocalMetadataAnalyzer {
  public readonly id = "fixture-failure";
  public readonly version = "1.0.0";

  public supports(task: HashTask): boolean {
    return task.extension === "foo";
  }

  public analyze(_task: HashTask, _absolutePath: string): Promise<AnalyzerOutcome> {
    return Promise.reject(new Error("intentional isolated analyzer failure"));
  }
}

async function createTrackedHarness(): Promise<Harness> {
  const fixture = await createInventoryFixture();
  const catalog = createCatalog(fixture.inventoryPath);
  const intelligence = new SqliteIntelligenceStore({ databasePath: fixture.inventoryPath });
  const organization = new SqliteOrganizationStore({
    databasePath: path.join(fixture.statePath, "organization.sqlite"),
  });
  const queue = new SqlitePersistentJobQueue({
    databasePath: fixture.jobsPath,
    definitions: [
      INVENTORY_SCAN_JOB_DEFINITION,
      DUPLICATE_DETECTION_JOB_DEFINITION,
      CONTENT_HASH_JOB_DEFINITION,
      METADATA_ANALYSIS_JOB_DEFINITION,
      RELATIONSHIP_ANALYSIS_JOB_DEFINITION,
    ],
  });
  const guard = createRootGuard(fixture.store);
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  const resolver = new ReadOnlyRootPathResolver(
    canonicalizer,
    new PathBoundary(process.platform === "win32" ? "win32" : "posix"),
  );
  const worker = new PersistentLocalWorker({
    id: "content-intelligence-test-worker" as WorkerId,
    queue,
    handlers: [
      new InventoryScanJobHandler(guard, catalog),
      new DuplicateCandidateJobHandler(intelligence),
      new ContentHashJobHandler(guard, resolver, intelligence),
      new MetadataAnalysisJobHandler(
        guard,
        resolver,
        intelligence,
        [...defaultMetadataAnalyzers(), new FixtureFailureAnalyzer()],
      ),
      new RelationshipAnalysisJobHandler(guard, intelligence),
    ],
  });
  const tools = new InventoryTools(queue, fixture.store, catalog);
  const analysis = new AnalysisService(catalog, fixture.store, queue, intelligence);
  const harness: Harness = {
    fixture,
    queue,
    catalog,
    intelligence,
    organization,
    worker,
    analysis,
    scan: async (key) => {
      const receipt = await tools.scan({
        rootId: fixture.root.id,
        idempotencyKey: key,
        requestedBy: "test-user",
      });
      expect(await worker.runOnce()).toBe("worked");
      const scan = await catalog.getScanByJob(receipt.jobId);
      if (scan === undefined) throw new Error("Inventory scan was not persisted.");
      return scan.id;
    },
    analyze: async (stages) => {
      const submission = await analysis.start({
        rootId: fixture.root.id,
        requestedBy: "test-user",
        ...(stages === undefined ? {} : { stages }),
      });
      for (const job of submission.jobs) {
        expect(job.receipt.status).toBe("queued");
        expect(await worker.runOnce()).toBe("worked");
      }
      return submission.scanId as InventoryScanId;
    },
    cleanup: async () => {
      queue.close();
      organization.close();
      intelligence.close();
      catalog.close();
      await fixture.cleanup();
    },
  };
  harnesses.push(harness);
  return harness;
}

async function recordsByPath(
  harness: Harness,
  scanId: InventoryScanId,
): Promise<Map<string, Awaited<ReturnType<Harness["catalog"]["get"]>> & {}>> {
  const page = await harness.catalog.list(harness.fixture.root.id, {
    scanId,
    entryType: "file",
    limit: 100,
  });
  return new Map(page.items.map((record) => [record.relativePath, record]));
}
