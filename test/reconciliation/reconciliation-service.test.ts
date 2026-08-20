import { rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JobId, RootRelativePath } from "../../src/domain/index.js";
import { newInventoryScanId } from "../../src/catalog/index.js";
import {
  ReconciliationScanNotCompletedError,
  ReconciliationScanNotFoundError,
  ReconciliationService,
} from "../../src/reconciliation/index.js";
import { ReconciliationRootMismatchError } from "../../src/reconciliation/reconcile.js";
import {
  createCatalog,
  createInventoryFixture,
  createInventoryTools,
  createInventoryWorker,
  createJobQueue,
  type InventoryTestFixture,
} from "../inventory/test-helpers.js";

const fixtures: InventoryTestFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function trackedFixture(): Promise<InventoryTestFixture> {
  const fixture = await createInventoryFixture();
  fixtures.push(fixture);
  return fixture;
}

describe("ReconciliationService", () => {
  it("reports added, missing, and metadata-changed paths between two completed scans", async () => {
    const fixture = await trackedFixture();
    await writeFile(path.join(fixture.rootPath, "stable.txt"), "unchanged", "utf8");
    await writeFile(path.join(fixture.rootPath, "shrinking.txt"), "0123456789", "utf8");
    await writeFile(path.join(fixture.rootPath, "removed.txt"), "gone-soon", "utf8");

    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const worker = createInventoryWorker(queue, catalog, fixture.store);

    const firstJob = await tools.scan({ rootId: fixture.root.id, idempotencyKey: "baseline" });
    await worker.runOnce();
    const baselineScan = await catalog.getScanByJob(firstJob.jobId);

    await rm(path.join(fixture.rootPath, "removed.txt"));
    await writeFile(path.join(fixture.rootPath, "shrinking.txt"), "01", "utf8");
    await writeFile(path.join(fixture.rootPath, "added.txt"), "new-file", "utf8");

    const secondJob = await tools.scan({ rootId: fixture.root.id, idempotencyKey: "comparison" });
    await worker.runOnce();
    const comparisonScan = await catalog.getScanByJob(secondJob.jobId);

    const service = new ReconciliationService(catalog);
    const report = await service.compare({
      rootId: fixture.root.id,
      baselineScanId: baselineScan!.id,
      comparisonScanId: comparisonScan!.id,
    });

    const relPath = (value: string): RootRelativePath => value as RootRelativePath;
    const byPath = new Map(report.deltas.map((delta) => [delta.relativePath, delta]));
    expect(byPath.has(relPath("stable.txt"))).toBe(false);
    expect(byPath.get(relPath("removed.txt"))).toMatchObject({ kind: "missing" });
    expect(byPath.get(relPath("added.txt"))).toMatchObject({ kind: "added" });
    expect(byPath.get(relPath("shrinking.txt"))).toMatchObject({
      kind: "metadata-changed",
      changedFields: expect.arrayContaining(["byteLength"]),
    });

    catalog.close();
    queue.close();
  });

  it("throws ReconciliationScanNotFoundError for an unknown scan id", async () => {
    const fixture = await trackedFixture();
    const catalog = createCatalog(fixture.inventoryPath);
    const service = new ReconciliationService(catalog);

    await expect(
      service.compare({
        rootId: fixture.root.id,
        baselineScanId: newInventoryScanId("missing-job" as JobId),
        comparisonScanId: newInventoryScanId("also-missing-job" as JobId),
      }),
    ).rejects.toBeInstanceOf(ReconciliationScanNotFoundError);

    catalog.close();
  });

  it("throws ReconciliationScanNotCompletedError when a scan is still running", async () => {
    const fixture = await trackedFixture();
    await writeFile(path.join(fixture.rootPath, "notes.txt"), "content", "utf8");

    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const worker = createInventoryWorker(queue, catalog, fixture.store);

    const completedJob = await tools.scan({ rootId: fixture.root.id, idempotencyKey: "done" });
    await worker.runOnce();
    const completedScan = await catalog.getScanByJob(completedJob.jobId);

    const runningScanId = newInventoryScanId("still-running-job" as JobId);
    await catalog.startOrLoadScan({
      id: runningScanId,
      rootId: fixture.root.id,
      jobId: "still-running-job" as JobId,
      rootIdentityKey: fixture.root.identity.key,
      startedAt: new Date().toISOString(),
    });

    const service = new ReconciliationService(catalog);
    await expect(
      service.compare({
        rootId: fixture.root.id,
        baselineScanId: completedScan!.id,
        comparisonScanId: runningScanId,
      }),
    ).rejects.toBeInstanceOf(ReconciliationScanNotCompletedError);

    catalog.close();
    queue.close();
  });

  it("throws ReconciliationRootMismatchError when a scan belongs to a different root", async () => {
    const fixtureA = await trackedFixture();
    const fixtureB = await trackedFixture();
    await writeFile(path.join(fixtureA.rootPath, "a.txt"), "a", "utf8");
    await writeFile(path.join(fixtureB.rootPath, "b.txt"), "b", "utf8");

    // Both roots share one catalog database to simulate a single application-state directory.
    const catalog = createCatalog(fixtureA.inventoryPath);
    const queueA = createJobQueue(fixtureA.jobsPath);
    const queueB = createJobQueue(fixtureB.jobsPath);
    const toolsA = createInventoryTools(queueA, catalog, fixtureA);
    const toolsB = createInventoryTools(queueB, catalog, fixtureB);

    const jobA = await toolsA.scan({ rootId: fixtureA.root.id, idempotencyKey: "root-a" });
    await createInventoryWorker(queueA, catalog, fixtureA.store).runOnce();
    const scanA = await catalog.getScanByJob(jobA.jobId);

    const jobB = await toolsB.scan({ rootId: fixtureB.root.id, idempotencyKey: "root-b" });
    await createInventoryWorker(queueB, catalog, fixtureB.store).runOnce();
    const scanB = await catalog.getScanByJob(jobB.jobId);

    const service = new ReconciliationService(catalog);
    await expect(
      service.compare({
        rootId: fixtureA.root.id,
        baselineScanId: scanA!.id,
        comparisonScanId: scanB!.id,
      }),
    ).rejects.toBeInstanceOf(ReconciliationRootMismatchError);

    catalog.close();
    queueA.close();
    queueB.close();
  });
});