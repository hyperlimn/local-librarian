import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteOrganizationStore } from "../../src/organization/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("organization audit persistence", () => {
  it("rejects updates and deletes through append-only database triggers", async () => {
    const databasePath = await newDatabasePath();
    const store = new SqliteOrganizationStore({ databasePath });
    await store.setMutationMode("live", "audit-test");
    store.close();

    const database = new DatabaseSync(databasePath);
    expect(() => database.prepare(
      "UPDATE organization_audit SET actor = 'rewritten' WHERE sequence = 1",
    ).run()).toThrow(/append-only/iu);
    expect(() => database.prepare(
      "DELETE FROM organization_audit WHERE sequence = 1",
    ).run()).toThrow(/append-only/iu);
    database.close();
  });

  it("detects a broken hash chain even if a privileged actor removes a trigger", async () => {
    const databasePath = await newDatabasePath();
    const store = new SqliteOrganizationStore({ databasePath });
    await store.setMutationMode("live", "audit-test");

    const database = new DatabaseSync(databasePath);
    database.exec("DROP TRIGGER organization_audit_reject_update");
    database.prepare(
      "UPDATE organization_audit SET details_json = ? WHERE sequence = 1",
    ).run('{"tampered":true}');
    database.close();

    await expect(store.verifyAuditIntegrity()).resolves.toMatchObject({
      valid: false,
      entriesChecked: 0,
      firstInvalidSequence: 1,
      reason: "An audit entry hash is invalid.",
    });
    store.close();
  });
});

async function newDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-organization-store-"));
  directories.push(directory);
  return path.join(directory, "organization.sqlite");
}
