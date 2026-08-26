import { access, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkerId } from "../../src/domain/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../../src/jobs/index.js";
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
  InventoryScanJobHandler,
} from "../../src/scanner/index.js";
import { InventoryTools } from "../../src/mcp/index.js";
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
  readonly organization: SqliteOrganizationStore;
  readonly service: OrganizationService;
  readonly worker: PersistentLocalWorker;
  scan(): Promise<void>;
  cleanup(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("turnkey organization workflow", () => {
  it("enforces live-enable and read-only confirmations independently", async () => {
    const harness = await trackedHarness();

    await expect(harness.service.setMutationMode(
      "live",
      "test-user",
      "DISABLE",
    )).rejects.toThrow("ENABLE LIVE FILE MUTATION");
    await expect(harness.organization.mutationMode()).resolves.toMatchObject({ mode: "read-only" });

    await expect(harness.service.setMutationMode(
      "live",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    )).resolves.toMatchObject({ mode: "live" });

    await expect(harness.service.setMutationMode(
      "read-only",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    )).rejects.toThrow("DISABLE");
    await expect(harness.organization.mutationMode()).resolves.toMatchObject({ mode: "live" });

    await expect(harness.service.setMutationMode(
      "read-only",
      "test-user",
      "DISABLE",
    )).resolves.toMatchObject({ mode: "read-only" });
  });

  it("builds a conservative plan and simulates it without mutating files", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.fixture.rootPath, "vacation.jpg"), "image", "utf8");
    await writeFile(path.join(harness.fixture.rootPath, "notes.txt"), "notes", "utf8");
    await writeFile(path.join(harness.fixture.rootPath, ".private.txt"), "private", "utf8");
    await mkdir(path.join(harness.fixture.rootPath, "Keep Together"));
    await writeFile(
      path.join(harness.fixture.rootPath, "Keep Together", "chapter.pdf"),
      "chapter",
      "utf8",
    );
    await harness.scan();

    const plan = await harness.service.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      scope: "top-level",
      targetDirectory: "Organized",
      collisionPolicy: "rename-with-suffix",
      createdBy: "test-user",
    });
    expect(plan.counts).toMatchObject({
      scannedFiles: 4,
      plannedMoves: 2,
      preservedByScope: 1,
      hiddenExcluded: 1,
      representedBytes: 10,
      byCategory: { Images: 1, Documents: 1 },
    });
    const operations = await harness.organization.listOperations(plan.id);
    expect(operations.items.map((operation) => operation.destinationRelativePath)).toEqual([
      "Organized/Documents/notes.txt",
      "Organized/Images/vacation.jpg",
    ]);

    const run = await harness.service.startRun({
      planId: plan.id,
      mode: "simulation",
      approvedBy: "test-user",
      confirmation: "SIMULATE",
    });
    await expect(harness.worker.runOnce()).resolves.toBe("worked");
    expect(await harness.organization.getRun(run.id)).toMatchObject({
      status: "completed",
      counts: { total: 2, processed: 2, succeeded: 2, skipped: 0, failed: 0 },
    });
    await expect(readFile(path.join(harness.fixture.rootPath, "notes.txt"), "utf8"))
      .resolves.toBe("notes");
    await expect(pathExists(path.join(harness.fixture.rootPath, "Organized"))).resolves.toBe(false);
  });

  it("requires both safety interlocks, applies atomically, and rolls back", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.fixture.rootPath, "photo.jpg"), "photo-bytes", "utf8");
    await harness.scan();
    const plan = await harness.service.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      createdBy: "test-user",
    });

    await expect(harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    })).rejects.toThrow("read-only");

    await harness.service.setMutationMode(
      "live",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    );
    await expect(harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    })).rejects.toThrow("explicit write approval");

    await harness.fixture.service.setLibraryWriteAccess(
      harness.fixture.root.id,
      true,
      "test-user",
    );
    const liveRun = await harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    });
    await expect(harness.worker.runOnce()).resolves.toBe("worked");
    expect(await pathExists(path.join(harness.fixture.rootPath, "photo.jpg"))).toBe(false);
    const organizedPath = path.join(
      harness.fixture.rootPath,
      "Organized",
      "Images",
      "photo.jpg",
    );
    await expect(readFile(organizedPath, "utf8")).resolves.toBe("photo-bytes");
    expect(await harness.organization.getRun(liveRun.id)).toMatchObject({
      status: "completed",
      counts: { succeeded: 1 },
    });

    const rollback = await harness.service.startRollback({
      sourceRunId: liveRun.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "ROLL BACK 1 FILE MOVES",
    });
    await expect(harness.worker.runOnce()).resolves.toBe("worked");
    await expect(readFile(path.join(harness.fixture.rootPath, "photo.jpg"), "utf8"))
      .resolves.toBe("photo-bytes");
    expect(await pathExists(organizedPath)).toBe(false);
    expect(await harness.organization.getRun(rollback.id)).toMatchObject({
      status: "completed",
      counts: { succeeded: 1 },
    });
    await expect(harness.organization.verifyAuditIntegrity()).resolves.toEqual({
      valid: true,
      entriesChecked: 12,
    });
  });

  it("stops a queued live run when the global mode is switched off", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.fixture.rootPath, "report.pdf"), "report", "utf8");
    await harness.scan();
    const plan = await harness.service.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      createdBy: "test-user",
    });
    await harness.fixture.service.setLibraryWriteAccess(
      harness.fixture.root.id,
      true,
      "test-user",
    );
    await harness.service.setMutationMode(
      "live",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    );
    const run = await harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    });
    await harness.service.setMutationMode("read-only", "test-user", "DISABLE");

    await expect(harness.worker.runOnce()).resolves.toBe("worked");
    expect(await harness.organization.getRun(run.id)).toMatchObject({
      status: "failed",
      error: { code: "FILE_MUTATION_DISABLED" },
    });
    await expect(readFile(path.join(harness.fixture.rootPath, "report.pdf"), "utf8"))
      .resolves.toBe("report");
  });

  it("refuses a live move when source metadata changed after inventory", async () => {
    const harness = await trackedHarness();
    const source = path.join(harness.fixture.rootPath, "data.csv");
    await writeFile(source, "before", "utf8");
    await harness.scan();
    const plan = await harness.service.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      createdBy: "test-user",
    });
    await harness.fixture.service.setLibraryWriteAccess(
      harness.fixture.root.id,
      true,
      "test-user",
    );
    await harness.service.setMutationMode(
      "live",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    );
    await writeFile(source, "changed-after-scan", "utf8");
    const run = await harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    });
    await harness.worker.runOnce();
    expect(await harness.organization.getRun(run.id)).toMatchObject({
      status: "partial",
      counts: { skipped: 1, succeeded: 0 },
    });
    await expect(readFile(source, "utf8")).resolves.toBe("changed-after-scan");
  });
  it("never overwrites a destination that appears after planning", async () => {
    const harness = await trackedHarness();
    const source = path.join(harness.fixture.rootPath, "contract.pdf");
    const destination = path.join(
      harness.fixture.rootPath,
      "Organized",
      "Documents",
      "contract.pdf",
    );
    await writeFile(source, "source-version", "utf8");
    await harness.scan();
    const plan = await harness.service.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      createdBy: "test-user",
    });
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "existing-version", "utf8");
    await harness.fixture.service.setLibraryWriteAccess(
      harness.fixture.root.id,
      true,
      "test-user",
    );
    await harness.service.setMutationMode(
      "live",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    );

    const run = await harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    });
    await harness.worker.runOnce();

    expect(await harness.organization.getRun(run.id)).toMatchObject({
      status: "partial",
      counts: { skipped: 1, succeeded: 0 },
    });
    await expect(readFile(source, "utf8")).resolves.toBe("source-version");
    await expect(readFile(destination, "utf8")).resolves.toBe("existing-version");
  });

  it("recovers a rename completed before its durable receipt was recorded", async () => {
    const harness = await trackedHarness();
    const source = path.join(harness.fixture.rootPath, "recovery.jpg");
    await writeFile(source, "rename crash window", "utf8");
    await harness.scan();
    const plan = await harness.service.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      createdBy: "test-user",
    });
    const operation = (await harness.organization.listOperations(plan.id)).items[0]!;
    const destination = path.join(
      harness.fixture.rootPath,
      ...operation.destinationRelativePath.split("/"),
    );
    await harness.fixture.service.setLibraryWriteAccess(
      harness.fixture.root.id,
      true,
      "test-user",
    );
    await harness.service.setMutationMode(
      "live",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    );
    const run = await harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    });

    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    await harness.worker.runOnce();

    expect(await harness.organization.getRun(run.id)).toMatchObject({
      status: "completed",
      counts: { succeeded: 1, failed: 0, skipped: 0 },
    });
    expect((await harness.organization.listRunItems(run.id)).items).toEqual([
      expect.objectContaining({ outcome: "already-completed" }),
    ]);
    await expect(readFile(destination, "utf8")).resolves.toBe("rename crash window");
    await expect(pathExists(source)).resolves.toBe(false);
  });

  it("fails closed when an enrolled volume disconnects before execution", async () => {
    const harness = await trackedHarness();
    const source = path.join(harness.fixture.rootPath, "offline.pdf");
    await writeFile(source, "offline but preserved", "utf8");
    await harness.scan();
    const plan = await harness.service.createPlan({
      rootId: harness.fixture.root.id,
      strategy: "category",
      createdBy: "test-user",
    });
    await harness.fixture.service.setLibraryWriteAccess(
      harness.fixture.root.id,
      true,
      "test-user",
    );
    await harness.service.setMutationMode(
      "live",
      "test-user",
      "ENABLE LIVE FILE MUTATION",
    );
    const run = await harness.service.startRun({
      planId: plan.id,
      mode: "live",
      approvedBy: "test-user",
      confirmation: "APPLY 1 FILE MOVES",
    });
    const disconnectedPath = `${harness.fixture.rootPath}-disconnected`;
    await rename(harness.fixture.rootPath, disconnectedPath);

    await harness.worker.runOnce();

    expect(await harness.organization.getRun(run.id)).toMatchObject({ status: "failed" });
    await expect(readFile(path.join(disconnectedPath, "offline.pdf"), "utf8"))
      .resolves.toBe("offline but preserved");
    await expect(pathExists(path.join(
      disconnectedPath,
      "Organized",
      "Documents",
      "offline.pdf",
    ))).resolves.toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a destination path redirected through a symlink",
    async () => {
      const harness = await trackedHarness();
      const source = path.join(harness.fixture.rootPath, "escape.txt");
      const outside = path.join(harness.fixture.directory, "outside-target");
      await writeFile(source, "must-stay-inside", "utf8");
      await harness.scan();
      const plan = await harness.service.createPlan({
        rootId: harness.fixture.root.id,
        strategy: "category",
        createdBy: "test-user",
      });
      await mkdir(outside);
      await symlink(outside, path.join(harness.fixture.rootPath, "Organized"), "dir");
      await harness.fixture.service.setLibraryWriteAccess(
        harness.fixture.root.id,
        true,
        "test-user",
      );
      await harness.service.setMutationMode(
        "live",
        "test-user",
        "ENABLE LIVE FILE MUTATION",
      );

      const run = await harness.service.startRun({
        planId: plan.id,
        mode: "live",
        approvedBy: "test-user",
        confirmation: "APPLY 1 FILE MOVES",
      });
      await harness.worker.runOnce();

      expect(await harness.organization.getRun(run.id)).toMatchObject({
        status: "partial",
        counts: { failed: 1, succeeded: 0 },
      });
      await expect(readFile(source, "utf8")).resolves.toBe("must-stay-inside");
      await expect(pathExists(path.join(outside, "Documents", "escape.txt")))
        .resolves.toBe(false);
    },
  );

  it("treats reserved control directories case-insensitively under Windows rules", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.fixture.rootPath, "notes.txt"), "notes", "utf8");
    await harness.scan();
    const planner = new OrganizationPlannerService(
      harness.catalog,
      harness.fixture.store,
      harness.organization,
      () => new Date("2026-08-25T00:00:00.000Z"),
      "win32",
    );

    await expect(planner.createPlan({
      rootId: harness.fixture.root.id,
      targetDirectory: ".LOCAL-LIBRARIAN/organized",
      createdBy: "test-user",
    })).rejects.toMatchObject({ code: "RESERVED_TARGET" });
  });

});

async function createHarness(): Promise<Harness> {
  const fixture = await createInventoryFixture();
  const queue = new SqlitePersistentJobQueue({
    databasePath: fixture.jobsPath,
    definitions: [
      INVENTORY_SCAN_JOB_DEFINITION,
      ORGANIZATION_EXECUTE_JOB_DEFINITION,
      ORGANIZATION_ROLLBACK_JOB_DEFINITION,
    ],
  });
  const catalog = createCatalog(fixture.inventoryPath);
  const organization = new SqliteOrganizationStore({
    databasePath: path.join(fixture.statePath, "organization.sqlite"),
  });
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  const boundary = new PathBoundary(process.platform === "win32" ? "win32" : "posix");
  const rootResolver = new ReadOnlyRootPathResolver(canonicalizer, boundary);
  const guard = createRootGuard(fixture.store);
  const worker = new PersistentLocalWorker({
    id: "organization-test-worker" as WorkerId,
    queue,
    handlers: [
      new InventoryScanJobHandler(guard, catalog),
      new OrganizationExecutionJobHandler(
        guard,
        organization,
        canonicalizer,
        rootResolver,
        boundary,
      ),
      new OrganizationRollbackJobHandler(
        guard,
        organization,
        canonicalizer,
        rootResolver,
        boundary,
      ),
    ],
  });
  const service = new OrganizationService(
    new OrganizationPlannerService(catalog, fixture.store, organization),
    organization,
    queue,
    fixture.store,
  );
  return {
    fixture,
    queue,
    catalog,
    organization,
    service,
    worker,
    scan: async () => {
      const tools = new InventoryTools(queue, fixture.store, catalog);
      await tools.scan({
        rootId: fixture.root.id,
        idempotencyKey: `scan-${Date.now()}-${Math.random()}`,
        requestedBy: "test-user",
      });
      await worker.runOnce();
    },
    cleanup: async () => {
      organization.close();
      catalog.close();
      queue.close();
      await fixture.cleanup();
    },
  };
}

async function trackedHarness(): Promise<Harness> {
  const harness = await createHarness();
  harnesses.push(harness);
  return harness;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
