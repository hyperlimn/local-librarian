import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteIntelligenceStore } from "../../src/intelligence/index.js";
import {
  createCatalog,
  createInventoryFixture,
  createInventoryTools,
  createInventoryWorker,
  createJobQueue,
  type InventoryTestFixture,
} from "../inventory/test-helpers.js";

const fixtures: InventoryTestFixture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("intelligence database migrations", () => {
  it("upgrades an unversioned V1 inventory in place without losing scans or records", async () => {
    const fixture = await createInventoryFixture();
    fixtures.push(fixture);
    await writeFile(path.join(fixture.rootPath, "preserved.txt"), "preserve me", "utf8");

    const catalog = createCatalog(fixture.inventoryPath);
    const queue = createJobQueue(fixture.jobsPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const receipt = await tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "migration-baseline",
      requestedBy: "test-user",
    });
    await createInventoryWorker(queue, catalog, fixture.store).runOnce();
    const scanBefore = await catalog.getScanByJob(receipt.jobId);
    expect(scanBefore).toMatchObject({
      status: "completed",
      counts: { filesDiscovered: 1 },
    });
    catalog.close();
    queue.close();

    const before = new DatabaseSync(fixture.inventoryPath, { readOnly: true });
    expect(before.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_migrations'`).get()).toBeUndefined();
    expect(Number(before.prepare("PRAGMA user_version").get()?.["user_version"])).toBe(0);
    before.close();

    const intelligence = new SqliteIntelligenceStore({
      databasePath: fixture.inventoryPath,
    });
    expect(intelligence.schemaVersion()).toBe(2);
    intelligence.close();

    const upgradedCatalog = createCatalog(fixture.inventoryPath);
    const preserved = await upgradedCatalog.list(fixture.root.id, {
      scanId: scanBefore!.id,
      entryType: "file",
      limit: 10,
    });
    expect(preserved.items).toEqual([
      expect.objectContaining({
        relativePath: "preserved.txt",
        byteLength: 11,
      }),
    ]);
    expect((await upgradedCatalog.summary(fixture.root.id)).latestScan).toMatchObject({
      id: scanBefore!.id,
      status: "completed",
    });
    upgradedCatalog.close();

    const after = new DatabaseSync(fixture.inventoryPath, { readOnly: true });
    expect(after.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all())
      .toEqual([
        { version: 1, name: "v1-unversioned-inventory-baseline" },
        { version: 2, name: "v2-content-intelligence" },
      ]);
    expect(after.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'content_identities'`).get()).toEqual({
      name: "content_identities",
    });
    after.close();
  });

  it("rolls back cleanly and closes the database when the V1 inventory schema is absent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-migration-failure-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "not-an-inventory.sqlite");

    expect(() => new SqliteIntelligenceStore({ databasePath }))
      .toThrow("The V1 inventory schema must exist");

    const database = new DatabaseSync(databasePath);
    expect(database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'content_identities'`).get()).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
      .toEqual({ count: 0 });
    expect(Number(database.prepare("PRAGMA user_version").get()?.["user_version"])).toBe(0);
    database.close();
  });
});
