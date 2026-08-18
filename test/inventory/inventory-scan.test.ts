import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InventoryCatalog, InventoryWriteBatch } from "../../src/catalog/index.js";
import type { InventoryMetadataFilesystem } from "../../src/scanner/index.js";
import { NodeInventoryMetadataFilesystem } from "../../src/scanner/index.js";
import {
  createCatalog,
  createInventoryFixture,
  createInventoryTools,
  createInventoryWorker,
  createJobQueue,
  type InventoryTestFixture,
} from "./test-helpers.js";

const fixtures: InventoryTestFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("inventory.scan metadata persistence", () => {
  it("scans an approved root, records metadata only, and returns a summary", async () => {
    const fixture = await trackedFixture();
    await mkdir(path.join(fixture.rootPath, "photos"));
    await writeFile(path.join(fixture.rootPath, "notes.txt"), "sentinel-content", "utf8");
    await writeFile(path.join(fixture.rootPath, "photos", "image.jpg"), "not-an-image", "utf8");
    const before = await stat(path.join(fixture.rootPath, "notes.txt"));
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const audited = new AuditedMetadataFilesystem();
    const tools = createInventoryTools(queue, catalog, fixture);
    const receipt = await tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "approved-scan",
    });

    expect(receipt.status).toBe("queued");
    await createInventoryWorker(queue, catalog, fixture.store, {
      filesystem: audited,
      batchSize: 2,
    }).runOnce();

    const summary = await tools.summary(fixture.root.id);
    expect(summary.latestScan).toMatchObject({
      status: "completed",
      counts: {
        filesDiscovered: 2,
        directoriesVisited: 2,
        bytesRepresented: 28,
        skippedEntries: 0,
        errorEntries: 0,
      },
    });
    const page = await tools.list(fixture.root.id, { limit: 10 });
    expect(page.items.map((record) => record.relativePath)).toEqual([
      "notes.txt",
      "photos",
      "photos/image.jpg",
    ]);
    expect(page.items.every((record) => record.contentIdentity.status === "not-requested")).toBe(true);
    expect(page.items.find((record) => record.relativePath === "notes.txt")).toMatchObject({
      extension: "txt",
      entryType: "file",
      byteLength: 16,
      observationStatus: "observed",
    });
    expect(audited.operations.every((operation) =>
      operation === "openDirectory" || operation === "lstat"
    )).toBe(true);
    expect(await readFile(path.join(fixture.rootPath, "notes.txt"), "utf8")).toBe(
      "sentinel-content",
    );
    const after = await stat(path.join(fixture.rootPath, "notes.txt"));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    catalog.close();
    queue.close();
  });

  it("paginates deterministically and retrieves an observation by stable ID", async () => {
    const fixture = await trackedFixture();
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) {
      await writeFile(path.join(fixture.rootPath, name), name, "utf8");
    }
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    await tools.scan({ rootId: fixture.root.id, idempotencyKey: "pagination" });
    await createInventoryWorker(queue, catalog, fixture.store).runOnce();

    const first = await tools.list(fixture.root.id, { limit: 2 });
    const second = await tools.list(fixture.root.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await tools.list(fixture.root.id, {
      limit: 2,
      cursor: second.nextCursor!,
    });
    const records = [...first.items, ...second.items, ...third.items];
    expect(records.map((record) => record.name)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
      "d.txt",
      "e.txt",
    ]);
    expect(new Set(records.map((record) => record.id)).size).toBe(5);
    await expect(tools.get(records[2]!.id)).resolves.toEqual(records[2]);
    catalog.close();
    queue.close();
  });

  it("preserves prior observations across repeated scans", async () => {
    const fixture = await trackedFixture();
    await writeFile(path.join(fixture.rootPath, "first.txt"), "first", "utf8");
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const firstJob = await tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "scan-one",
    });
    const worker = createInventoryWorker(queue, catalog, fixture.store);
    await worker.runOnce();
    const firstScan = await catalog.getScanByJob(firstJob.jobId);
    await writeFile(path.join(fixture.rootPath, "second.txt"), "second", "utf8");
    const secondJob = await tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "scan-two",
    });
    await worker.runOnce();
    const secondScan = await catalog.getScanByJob(secondJob.jobId);

    expect(firstScan?.id).not.toBe(secondScan?.id);
    expect((await tools.summary(fixture.root.id)).retainedScanCount).toBe(2);
    expect((await tools.list(fixture.root.id)).items).toHaveLength(2);
    expect((await tools.list(fixture.root.id, { scanId: firstScan!.id })).items).toHaveLength(1);
    catalog.close();
    queue.close();
  });

  it("bounds every SQLite write batch on a large synthetic tree", async () => {
    const fixture = await trackedFixture();
    for (let directory = 0; directory < 20; directory += 1) {
      const directoryPath = path.join(fixture.rootPath, `directory-${directory}`);
      await mkdir(directoryPath);
      for (let file = 0; file < 20; file += 1) {
        await writeFile(path.join(directoryPath, `file-${file}.txt`), "x", "utf8");
      }
    }
    const queue = createJobQueue(fixture.jobsPath);
    const concreteCatalog = createCatalog(fixture.inventoryPath);
    let maximumBatchSize = 0;
    let batchCount = 0;
    const catalog = new Proxy(concreteCatalog, {
      get(target, property) {
        if (property === "writeBatch") {
          return async (
            id: Parameters<InventoryCatalog["writeBatch"]>[0],
            batch: InventoryWriteBatch,
            updatedAt: string,
          ) => {
            maximumBatchSize = Math.max(maximumBatchSize, batch.observations.length);
            batchCount += 1;
            return target.writeBatch(id, batch, updatedAt);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as InventoryCatalog;
    const tools = createInventoryTools(queue, catalog, fixture);
    await tools.scan({ rootId: fixture.root.id, idempotencyKey: "large-tree" });
    const worker = new (await import("../../src/jobs/index.js")).PersistentLocalWorker({
      id: "large-tree-worker" as import("../../src/domain/index.js").WorkerId,
      queue,
      handlers: [
        new (await import("../../src/scanner/index.js")).InventoryScanJobHandler(
          (await import("./test-helpers.js")).createRootGuard(fixture.store),
          catalog,
          { batchSize: 17 },
        ),
      ],
    });
    await worker.runOnce();

    expect(maximumBatchSize).toBeLessThanOrEqual(17);
    expect(batchCount).toBeGreaterThan(20);
    expect((await tools.summary(fixture.root.id)).latestScan?.counts).toMatchObject({
      filesDiscovered: 400,
      directoriesVisited: 21,
    });
    concreteCatalog.close();
    queue.close();
  }, 20_000);
});

class AuditedMetadataFilesystem implements InventoryMetadataFilesystem {
  public readonly operations: string[] = [];
  readonly #delegate = new NodeInventoryMetadataFilesystem();

  public openDirectory(pathValue: string, bufferSize: number) {
    this.operations.push("openDirectory");
    return this.#delegate.openDirectory(pathValue, bufferSize);
  }

  public lstat(pathValue: string) {
    this.operations.push("lstat");
    return this.#delegate.lstat(pathValue);
  }
}

async function trackedFixture(): Promise<InventoryTestFixture> {
  const fixture = await createInventoryFixture();
  fixtures.push(fixture);
  return fixture;
}
