import { afterEach, describe, expect, it, vi } from "vitest";

import type { SqliteInventoryCatalog } from "../../src/catalog/index.js";
import type {
  InventoryRecord,
  InventoryRecordId,
  InventoryScanId,
  JobId,
  LibraryRootId,
  RootRelativePath,
  WorkerId,
} from "../../src/domain/index.js";
import {
  RECONCILIATION_JOB_DEFINITION,
  ReconciliationJobHandler,
  ScalableReconciliationService,
  SqliteIntelligenceStore,
} from "../../src/intelligence/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../../src/jobs/index.js";
import {
  createCatalog,
  createInventoryFixture,
  type InventoryTestFixture,
} from "../inventory/test-helpers.js";

const UNCHANGED = 2_500;
const CHANGED = 1_300;
const MISSING = 1_200;
const ADDED = 1_700;
const EXPECTED_DELTAS = CHANGED + MISSING + ADDED;

interface SyntheticFact {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly modifiedAt: string;
}

interface TrackedResources {
  readonly fixture: InventoryTestFixture;
  readonly catalog: SqliteInventoryCatalog;
  readonly intelligence: SqliteIntelligenceStore;
  readonly queue: SqlitePersistentJobQueue;
}

const resources: TrackedResources[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.queue.close();
    resource.intelligence.close();
    resource.catalog.close();
    await resource.fixture.cleanup();
  }
  vi.restoreAllMocks();
});

describe("scalable persisted reconciliation", () => {
  it("batches a large catalog, resumes from a checkpoint, and pages durable deltas", async () => {
    const fixture = await createInventoryFixture();
    const catalog = createCatalog(fixture.inventoryPath);
    const baselineScanId = "synthetic-baseline" as InventoryScanId;
    const comparisonScanId = "synthetic-comparison" as InventoryScanId;

    await seedScan(
      catalog,
      fixture.root.id,
      fixture.root.identity.key,
      baselineScanId,
      "synthetic-baseline-job" as JobId,
      baselineFacts(),
    );
    await seedScan(
      catalog,
      fixture.root.id,
      fixture.root.identity.key,
      comparisonScanId,
      "synthetic-comparison-job" as JobId,
      comparisonFacts(),
    );

    const intelligence = new SqliteIntelligenceStore({
      databasePath: fixture.inventoryPath,
    });
    const queue = new SqlitePersistentJobQueue({
      databasePath: fixture.jobsPath,
      definitions: [RECONCILIATION_JOB_DEFINITION],
    });
    resources.push({ fixture, catalog, intelligence, queue });

    const service = new ScalableReconciliationService(intelligence, queue);
    const run = await service.compare({
      rootId: fixture.root.id,
      baselineScanId,
      comparisonScanId,
      requestedBy: "scaling-test",
    });
    expect(run.jobId).toBeDefined();
    const jobId = run.jobId as JobId;

    const originalWork = intelligence.reconciliationWork.bind(intelligence);
    let maximumBatchSize = 0;
    let nonEmptyBatchCount = 0;
    let pauseRequested = false;
    vi.spyOn(intelligence, "reconciliationWork").mockImplementation(
      async (id, kind, afterRelativePath, limit) => {
        const items = await originalWork(id, kind, afterRelativePath, limit);
        maximumBatchSize = Math.max(maximumBatchSize, items.length);
        if (items.length > 0) nonEmptyBatchCount += 1;
        if (!pauseRequested && items.length > 0) {
          pauseRequested = true;
          await queue.requestPause(jobId, "scaling-test");
        }
        return items;
      },
    );

    const worker = new PersistentLocalWorker({
      id: "reconciliation-scaling-worker" as WorkerId,
      queue,
      handlers: [new ReconciliationJobHandler(intelligence)],
    });
    expect(await worker.runOnce()).toBe("worked");
    expect(await queue.status(jobId)).toMatchObject({ status: "paused" });
    expect(await service.get(run.id)).toMatchObject({
      status: "paused",
      phase: "missing",
      processed: 1_000,
      counts: { missing: 1_000, added: 0, metadataChanged: 0 },
    });

    await queue.resume(jobId, "scaling-test");
    expect(await worker.runOnce()).toBe("worked");
    expect(await queue.status(jobId)).toMatchObject({ status: "completed" });
    expect(await service.get(run.id)).toMatchObject({
      status: "completed",
      phase: "complete",
      processed: EXPECTED_DELTAS,
      counts: {
        missing: MISSING,
        added: ADDED,
        metadataChanged: CHANGED,
      },
    });
    expect(maximumBatchSize).toBe(1_000);
    expect(nonEmptyBatchCount).toBeGreaterThan(3);

    let cursor: string | undefined;
    let pagedCount = 0;
    do {
      const page = await service.deltas(run.id, {
        limit: 137,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.items.length).toBeLessThanOrEqual(137);
      pagedCount += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pagedCount).toBe(EXPECTED_DELTAS);

    const changed = await service.deltas(run.id, {
      kind: "metadata-changed",
      search: "changed/00042.bin",
      limit: 10,
    });
    expect(changed.items).toEqual([
      expect.objectContaining({
        relativePath: "changed/00042.bin",
        kind: "metadata-changed",
        changedFields: expect.arrayContaining(["byteLength", "modifiedAt"]),
        before: expect.objectContaining({
          byteLength: 1_042,
          modifiedAt: "2025-01-01T00:00:00.000Z",
        }),
        after: expect.objectContaining({
          byteLength: 2_042,
          modifiedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
    ]);

    const repeated = await service.compare({
      rootId: fixture.root.id,
      baselineScanId,
      comparisonScanId,
      requestedBy: "scaling-test",
    });
    expect(repeated).toMatchObject({ id: run.id, jobId, status: "completed" });
  });
});

async function seedScan(
  catalog: SqliteInventoryCatalog,
  rootId: LibraryRootId,
  rootIdentityKey: string,
  scanId: InventoryScanId,
  jobId: JobId,
  facts: Iterable<SyntheticFact>,
): Promise<void> {
  const observedAt = "2026-02-01T00:00:00.000Z";
  await catalog.startOrLoadScan({
    id: scanId,
    rootId,
    jobId,
    rootIdentityKey,
    startedAt: observedAt,
  });
  let batch: InventoryRecord[] = [];
  for (const fact of facts) {
    const name = fact.relativePath.split("/").at(-1) ?? fact.relativePath;
    batch.push({
      id: `record:${scanId}:${fact.relativePath}` as InventoryRecordId,
      scanId,
      rootId,
      jobId,
      relativePath: fact.relativePath as RootRelativePath,
      name,
      extension: "bin",
      entryType: "file",
      observationStatus: "observed",
      byteLength: fact.byteLength,
      modifiedAt: fact.modifiedAt,
      attributes: { hidden: false, system: false, readOnly: false },
      contentIdentity: { status: "not-requested" },
      observedAt,
    });
    if (batch.length === 500) {
      await catalog.writeBatch(scanId, { observations: batch, discoveredDirectories: [] }, observedAt);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await catalog.writeBatch(scanId, { observations: batch, discoveredDirectories: [] }, observedAt);
  }
  await catalog.setScanStatus(scanId, "completed", observedAt);
}

function* baselineFacts(): Iterable<SyntheticFact> {
  yield* facts("unchanged", UNCHANGED, 100, "2025-01-01T00:00:00.000Z");
  yield* facts("changed", CHANGED, 1_000, "2025-01-01T00:00:00.000Z");
  yield* facts("missing", MISSING, 3_000, "2025-01-01T00:00:00.000Z");
}

function* comparisonFacts(): Iterable<SyntheticFact> {
  yield* facts("unchanged", UNCHANGED, 100, "2025-01-01T00:00:00.000Z");
  yield* facts("changed", CHANGED, 2_000, "2026-01-01T00:00:00.000Z");
  yield* facts("added", ADDED, 4_000, "2026-01-01T00:00:00.000Z");
}

function* facts(
  directory: string,
  count: number,
  baseSize: number,
  modifiedAt: string,
): Iterable<SyntheticFact> {
  for (let index = 0; index < count; index += 1) {
    yield {
      relativePath: `${directory}/${String(index).padStart(5, "0")}.bin`,
      byteLength: baseSize + index,
      modifiedAt,
    };
  }
}
