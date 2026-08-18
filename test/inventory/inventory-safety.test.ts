import type { BigIntStats } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LibraryRootId } from "../../src/domain/index.js";
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

describe("inventory.scan safety", () => {
  it("rejects unknown, ingest-role, and currently revoked roots at submission", async () => {
    const fixture = await trackedFixture();
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);

    await expect(tools.scan({
      rootId: "unknown-root" as LibraryRootId,
      idempotencyKey: "unknown",
    })).rejects.toThrow("not enrolled");

    const ingestProposal = await fixture.service.propose({
      role: "ingest-source",
      ingestSourceKind: "drop-directory",
      path: fixture.rootPath,
      displayName: "Not a library",
    });
    const ingest = await fixture.service.approve(ingestProposal.proposalId, "test-user");
    await expect(tools.scan({
      rootId: ingest.id as unknown as LibraryRootId,
      idempotencyKey: "ingest-role",
    })).rejects.toThrow("not a library root");

    await fixture.service.revoke(fixture.root.id, "test revocation");
    await expect(tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "revoked",
    })).rejects.toThrow("not currently approved");
    expect((await queue.list()).items).toHaveLength(0);
    catalog.close();
    queue.close();
  });

  it("revalidates approval in the worker and rejects a root revoked after submission", async () => {
    const fixture = await trackedFixture();
    await writeFile(path.join(fixture.rootPath, "file.txt"), "fixture", "utf8");
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const receipt = await tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "revoke-after-submit",
    });
    await fixture.service.revoke(fixture.root.id, "revoked before worker claim");

    await createInventoryWorker(queue, catalog, fixture.store).runOnce();
    expect(await queue.result(receipt.jobId)).toMatchObject({
      status: "failed",
      error: { code: "ROOT_NOT_APPROVED", retryable: false },
    });
    catalog.close();
    queue.close();
  });

  it("stops at the next batch boundary if approval is revoked during traversal", async () => {
    const fixture = await trackedFixture();
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(fixture.rootPath, `file-${index}.txt`), "x", "utf8");
    }
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const receipt = await tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "revoke-during",
    });
    let revoked = false;
    const worker = createInventoryWorker(queue, catalog, fixture.store, {
      batchSize: 3,
      afterBatch: async () => {
        if (!revoked) {
          revoked = true;
          await fixture.service.revoke(fixture.root.id, "revoked during scan");
        }
      },
    });

    await worker.runOnce();
    expect(await queue.result(receipt.jobId)).toMatchObject({
      status: "failed",
      error: { code: "ROOT_NOT_APPROVED", retryable: false },
    });
    const summary = await tools.summary(fixture.root.id);
    expect(summary.latestScan?.status).toBe("failed");
    expect(summary.latestScan!.counts.filesDiscovered).toBeLessThan(20);
    catalog.close();
    queue.close();
  });

  it("records a symlink or junction escape and never traverses its target", async () => {
    const fixture = await trackedFixture();
    const outside = path.join(fixture.directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "must-not-be-inventoried", "utf8");
    try {
      await symlink(
        outside,
        path.join(fixture.rootPath, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (isPermissionError(error)) return;
      throw error;
    }
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    await tools.scan({ rootId: fixture.root.id, idempotencyKey: "link-escape" });
    await createInventoryWorker(queue, catalog, fixture.store).runOnce();

    const records = (await tools.list(fixture.root.id, { limit: 100 })).items;
    expect(records).toMatchObject([
      {
        relativePath: "escape",
        entryType: "symbolic-link",
        observationStatus: "skipped",
        issue: { code: "REPARSE_POINT_FORBIDDEN" },
      },
    ]);
    expect(records.some((record) => record.relativePath.includes("secret.txt"))).toBe(false);
    catalog.close();
    queue.close();
  });

  it("skips an entry whose metadata reports a different filesystem device", async () => {
    const fixture = await trackedFixture();
    const crossingPath = path.join(fixture.rootPath, "mounted.dat");
    await writeFile(crossingPath, "fixture", "utf8");
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    await tools.scan({ rootId: fixture.root.id, idempotencyKey: "device-boundary" });
    await createInventoryWorker(queue, catalog, fixture.store, {
      filesystem: new DeviceMismatchFilesystem(crossingPath),
    }).runOnce();

    const records = (await tools.list(fixture.root.id)).items;
    expect(records).toMatchObject([
      {
        relativePath: "mounted.dat",
        observationStatus: "skipped",
        issue: { code: "FILESYSTEM_BOUNDARY_CROSSING" },
      },
    ]);
    expect((await tools.summary(fixture.root.id)).latestScan?.counts.filesDiscovered).toBe(0);
    catalog.close();
    queue.close();
  });

  it("records disappearing and inaccessible entries without failing the scan", async () => {
    const fixture = await trackedFixture();
    const vanished = path.join(fixture.rootPath, "vanished.txt");
    const blocked = path.join(fixture.rootPath, "blocked");
    await writeFile(vanished, "fixture", "utf8");
    await mkdir(blocked);
    await writeFile(path.join(blocked, "inside.txt"), "fixture", "utf8");
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    await tools.scan({ rootId: fixture.root.id, idempotencyKey: "volatile" });
    await createInventoryWorker(queue, catalog, fixture.store, {
      filesystem: new VolatileFilesystem(vanished, blocked),
    }).runOnce();

    const records = (await tools.list(fixture.root.id, { limit: 100 })).items;
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: "vanished.txt",
        observationStatus: "skipped",
        issue: { code: "ENTRY_VANISHED", message: expect.any(String) },
      }),
      expect.objectContaining({
        relativePath: "blocked",
        observationStatus: "error",
        issue: { code: "DIRECTORY_INACCESSIBLE", message: expect.any(String) },
      }),
    ]));
    expect((await tools.summary(fixture.root.id)).latestScan).toMatchObject({
      status: "completed",
      counts: { skippedEntries: 1, errorEntries: 1 },
    });
    catalog.close();
    queue.close();
  });
});

class DeviceMismatchFilesystem implements InventoryMetadataFilesystem {
  readonly #delegate = new NodeInventoryMetadataFilesystem();

  public constructor(private readonly crossingPath: string) {}

  public openDirectory(pathValue: string, bufferSize: number) {
    return this.#delegate.openDirectory(pathValue, bufferSize);
  }

  public async lstat(pathValue: string): Promise<BigIntStats> {
    const stats = await this.#delegate.lstat(pathValue);
    if (path.resolve(pathValue) !== path.resolve(this.crossingPath)) return stats;
    return new Proxy(stats, {
      get(target, property, receiver) {
        if (property === "dev") return target.dev + 1n;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

class VolatileFilesystem implements InventoryMetadataFilesystem {
  readonly #delegate = new NodeInventoryMetadataFilesystem();

  public constructor(
    private readonly vanishedPath: string,
    private readonly blockedPath: string,
  ) {}

  public openDirectory(pathValue: string, bufferSize: number) {
    if (path.resolve(pathValue) === path.resolve(this.blockedPath)) {
      return Promise.reject(nodeError("EACCES", "synthetic inaccessible directory"));
    }
    return this.#delegate.openDirectory(pathValue, bufferSize);
  }

  public lstat(pathValue: string) {
    if (path.resolve(pathValue) === path.resolve(this.vanishedPath)) {
      return Promise.reject(nodeError("ENOENT", "synthetic vanished entry"));
    }
    return this.#delegate.lstat(pathValue);
  }
}

function nodeError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EPERM" ||
      (error as NodeJS.ErrnoException).code === "EACCES")
  );
}

async function trackedFixture(): Promise<InventoryTestFixture> {
  const fixture = await createInventoryFixture();
  fixtures.push(fixture);
  return fixture;
}

