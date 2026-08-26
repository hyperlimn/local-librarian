import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteInventoryCatalog } from "../../src/catalog/index.js";
import type { WorkerId } from "../../src/domain/index.js";
import {
  JsonlRootEnrollmentStore,
  RootEnrollmentService,
} from "../../src/enrollment/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../../src/jobs/index.js";
import { SqliteIntelligenceStore } from "../../src/intelligence/index.js";
import { SqliteOrganizationStore } from "../../src/organization/index.js";
import {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
} from "../../src/safety/index.js";
import { INVENTORY_SCAN_JOB_DEFINITION } from "../../src/scanner/index.js";
import {
  INGEST_ANALYSIS_JOB_DEFINITION,
  INGEST_TRANSFER_JOB_DEFINITION,
  QUARANTINE_RESTORE_JOB_DEFINITION,
  IngestAnalysisJobHandler,
  IngestTransferJobHandler,
  QuarantineRestoreJobHandler,
  SqliteTransferStore,
  TransferRootGuard,
  TransferService,
  type TransferCapacityProbe,
} from "../../src/transfer/index.js";
import { TestVolumeIdentityProvider } from "../inventory/test-helpers.js";

interface Harness {
  readonly directory: string;
  readonly libraryPath: string;
  readonly sourcePath: string;
  readonly enrollment: RootEnrollmentService;
  readonly library: Awaited<ReturnType<RootEnrollmentService["approve"]>>;
  readonly source: Awaited<ReturnType<RootEnrollmentService["approve"]>>;
  readonly organization: SqliteOrganizationStore;
  readonly transfers: SqliteTransferStore;
  readonly queue: SqlitePersistentJobQueue;
  readonly service: TransferService;
  readonly worker: PersistentLocalWorker;
  cleanup(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("verified ingest and quarantine workflow", () => {
  it("copies by default, verifies the destination, catalogs via a follow-up job, and preserves source", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.sourcePath, "notes.txt"), "private local notes", "utf8");
    await mkdir(path.join(harness.sourcePath, "project"));
    await writeFile(path.join(harness.sourcePath, "project", "package.json"), "{}", "utf8");

    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      requestedBy: "test-user",
    });
    expect(plan.status).toBe("analysis-queued");
    await expect(harness.worker.runOnce()).resolves.toBe("worked");

    const analyzed = await harness.transfers.plan(plan.id);
    expect(analyzed).toMatchObject({
      status: "ready-for-approval",
      counts: { total: 2, ready: 2, exactDuplicates: 0, needsReview: 0 },
    });
    const items = await harness.transfers.items(plan.id, { limit: 10 });
    expect(items.items.map((item) => item.destinationRelativePath)).toEqual([
      "Imported/Documents/notes.txt",
      "Imported/project/package.json",
    ]);
    expect(items.items.every((item) => item.digestHex?.length === 64)).toBe(true);

    await harness.service.approve(plan.id, "test-user", "IMPORT 2 FILES");
    await expect(harness.worker.runOnce()).resolves.toBe("worked");
    expect(await harness.transfers.plan(plan.id)).toMatchObject({
      status: "completed",
      counts: { completed: 2, failed: 0 },
    });
    await expect(readFile(path.join(harness.libraryPath, "Imported", "Documents", "notes.txt"), "utf8"))
      .resolves.toBe("private local notes");
    await expect(readFile(path.join(harness.libraryPath, "Imported", "project", "package.json"), "utf8"))
      .resolves.toBe("{}");
    await expect(readFile(path.join(harness.sourcePath, "notes.txt"), "utf8"))
      .resolves.toBe("private local notes");
    expect(await harness.transfers.receiptForPlan(plan.id)).toMatchObject({
      formatVersion: 2,
      status: "completed",
    });
  });

  it("retires a source only after verified copy, records quarantine, and restores safely", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.sourcePath, "camera.jpg"), "camera payload", "utf8");
    await harness.enrollment.setIngestSourceRetirementAccess(
      harness.source.id as never,
      true,
      true,
      "test-user",
    );

    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      targetDirectory: "Camera Import",
      retireSource: true,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    await harness.service.approve(
      plan.id,
      "test-user",
      "IMPORT 1 FILES AND QUARANTINE SOURCES",
    );
    await harness.worker.runOnce();

    await expect(readFile(path.join(harness.libraryPath, "Camera Import", "Images", "camera.jpg"), "utf8"))
      .resolves.toBe("camera payload");
    await expect(pathExists(path.join(harness.sourcePath, "camera.jpg"))).resolves.toBe(false);
    const quarantine = await harness.transfers.quarantine({ status: "active" });
    expect(quarantine.items).toHaveLength(1);
    expect(quarantine.items[0]).toMatchObject({
      originalRelativePath: "camera.jpg",
      reason: "verified-source-retirement",
      status: "active",
    });
    const quarantined = quarantine.items[0]!;
    await expect(readFile(path.join(harness.sourcePath, ...quarantined.quarantinedRelativePath.split("/")), "utf8"))
      .resolves.toBe("camera payload");

    await harness.service.restore(
      quarantined.id,
      "test-user",
      "RESTORE camera.jpg",
    );
    await harness.worker.runOnce();
    await expect(readFile(path.join(harness.sourcePath, "camera.jpg"), "utf8"))
      .resolves.toBe("camera payload");
    expect(await harness.transfers.quarantineItem(quarantined.id)).toMatchObject({ status: "restored" });
    const audit = await harness.transfers.audit();
    const events = audit.map((event) => event.event);
    expect(events.indexOf("file-quarantined")).toBeGreaterThan(events.indexOf("plan-created"));
    expect(events.indexOf("file-restored")).toBeGreaterThan(events.indexOf("file-quarantined"));
    expect(audit[0]?.previousHash).toBe("0".repeat(64));
    for (let index = 1; index < audit.length; index += 1) {
      expect(audit[index]?.previousHash).toBe(audit[index - 1]?.hash);
    }
  });

  it("rechecks READ ONLY at execution and leaves all user data untouched", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.sourcePath, "locked.pdf"), "do not move", "utf8");
    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    await harness.service.approve(plan.id, "test-user", "IMPORT 1 FILES");
    await harness.organization.setMutationMode("read-only", "test-user");

    await harness.worker.runOnce();
    await expect(readFile(path.join(harness.sourcePath, "locked.pdf"), "utf8"))
      .resolves.toBe("do not move");
    await expect(pathExists(path.join(harness.libraryPath, "Imported", "Documents", "locked.pdf")))
      .resolves.toBe(false);
    expect(await harness.transfers.plan(plan.id)).toMatchObject({
      status: "failed",
      error: { code: "MUTATION_GATE_CHANGED" },
    });
  });

  it("refuses a destination collision without overwriting it or retiring the source", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.sourcePath, "collision.txt"), "source", "utf8");
    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    await mkdir(path.join(harness.libraryPath, "Imported", "Documents"), { recursive: true });
    await writeFile(
      path.join(harness.libraryPath, "Imported", "Documents", "collision.txt"),
      "existing",
      "utf8",
    );
    await harness.service.approve(plan.id, "test-user", "IMPORT 1 FILES");
    await harness.worker.runOnce();

    await expect(readFile(path.join(harness.sourcePath, "collision.txt"), "utf8")).resolves.toBe("source");
    await expect(readFile(path.join(harness.libraryPath, "Imported", "Documents", "collision.txt"), "utf8"))
      .resolves.toBe("existing");
    expect(await harness.transfers.plan(plan.id)).toMatchObject({
      status: "partial",
      counts: { failed: 1 },
    });
  });

  it("resumes a durable partial staging copy after an interrupted worker", async () => {
    const harness = await trackedHarness();
    const payload = Buffer.alloc(512 * 1024 + 333, 0x5a);
    const partialBytes = 256 * 1024;
    await writeFile(path.join(harness.sourcePath, "large-video.mp4"), payload);
    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    const analyzedItems = await harness.transfers.items(plan.id, { limit: 10 });
    const item = analyzedItems.items[0]!;
    const approved = await harness.service.approve(plan.id, "test-user", "IMPORT 1 FILES");

    const stagingPath = transferStagingPath(harness.libraryPath, plan.id, item.id);
    await mkdir(path.dirname(stagingPath), { recursive: true });
    await writeFile(stagingPath, payload.subarray(0, partialBytes));
    const stagingInspection = await new ReadOnlyCanonicalPathResolver().inspectExisting(
      path.dirname(stagingPath),
    );
    expect(stagingInspection).toMatchObject({
      entryKind: "directory",
      deviceId: harness.library.identity.volume.deviceId,
      reparsePoints: [],
    });
    await harness.transfers.setItemState(item.id, "copying", new Date().toISOString(), {
      copiedBytes: partialBytes,
    });

    await harness.worker.runOnce();
    expect(await harness.queue.status(approved.transferJobId as never)).toMatchObject({
      status: "completed",
    });
    const completedItem = await harness.transfers.item(item.id);
    expect(completedItem?.error).toBeUndefined();
    expect(completedItem).toMatchObject({
      status: "completed",
      copiedBytes: payload.byteLength,
    });
    await expect(readFile(
      path.join(
        harness.libraryPath,
        ...completedItem!.destinationRelativePath!.split("/"),
      ),
    )).resolves.toEqual(payload);
    await expect(readFile(path.join(harness.sourcePath, "large-video.mp4"))).resolves.toEqual(payload);
    await expect(pathExists(stagingPath)).resolves.toBe(false);
  });

  it("preserves all reachable data when the source disappears after approval", async () => {
    const harness = await trackedHarness();
    const sourceFile = path.join(harness.sourcePath, "vanishing.txt");
    await writeFile(sourceFile, "observed before approval", "utf8");
    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    await harness.service.approve(plan.id, "test-user", "IMPORT 1 FILES");
    await rm(sourceFile);

    await harness.worker.runOnce();
    await expect(pathExists(path.join(
      harness.libraryPath,
      "Imported",
      "Documents",
      "vanishing.txt",
    ))).resolves.toBe(false);
    expect(await harness.transfers.plan(plan.id)).toMatchObject({
      status: "partial",
      counts: { completed: 0, failed: 1 },
    });
    expect((await harness.transfers.items(plan.id, { limit: 10 })).items[0]).toMatchObject({
      status: "failed",
      error: { code: "STALE_OR_DISAPPEARING_SOURCE", retryable: false },
    });
  });

  it("refuses insufficient destination capacity before copying user data", async () => {
    const harness = await trackedHarness({ capacityProbe: async () => 0n });
    await writeFile(path.join(harness.sourcePath, "too-large.zip"), "source remains", "utf8");
    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    await harness.service.approve(plan.id, "test-user", "IMPORT 1 FILES");

    await harness.worker.runOnce();
    await expect(readFile(path.join(harness.sourcePath, "too-large.zip"), "utf8"))
      .resolves.toBe("source remains");
    await expect(pathExists(path.join(
      harness.libraryPath,
      "Imported",
      "Archives",
      "too-large.zip",
    ))).resolves.toBe(false);
    expect((await harness.transfers.items(plan.id, { limit: 10 })).items[0]).toMatchObject({
      status: "failed",
      copiedBytes: 0,
      error: { code: "INSUFFICIENT_DISK_SPACE", retryable: false },
    });
  });

  it("rechecks destination write approval at execution time", async () => {
    const harness = await trackedHarness();
    await writeFile(path.join(harness.sourcePath, "gate.txt"), "gated", "utf8");
    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    await harness.service.approve(plan.id, "test-user", "IMPORT 1 FILES");
    await harness.enrollment.setLibraryWriteAccess(
      harness.library.id as never,
      false,
      "test-user",
    );

    await harness.worker.runOnce();
    await expect(readFile(path.join(harness.sourcePath, "gate.txt"), "utf8"))
      .resolves.toBe("gated");
    await expect(pathExists(path.join(
      harness.libraryPath,
      "Imported",
      "Documents",
      "gate.txt",
    ))).resolves.toBe(false);
    expect(await harness.transfers.plan(plan.id)).toMatchObject({
      status: "failed",
      error: { code: "WRITES_DISABLED" },
    });
  });

  it("keeps a collision-blocked restore recoverable and allows a later retry", async () => {
    const harness = await trackedHarness();
    const original = path.join(harness.sourcePath, "retry.jpg");
    await writeFile(original, "quarantined payload", "utf8");
    await harness.enrollment.setIngestSourceRetirementAccess(
      harness.source.id as never,
      true,
      true,
      "test-user",
    );
    const plan = await harness.service.createIngestPlan({
      sourceRootId: harness.source.id,
      destinationRootId: harness.library.id as never,
      retireSource: true,
      requestedBy: "test-user",
    });
    await harness.worker.runOnce();
    await harness.service.approve(
      plan.id,
      "test-user",
      "IMPORT 1 FILES AND QUARANTINE SOURCES",
    );
    await harness.worker.runOnce();
    const quarantined = (await harness.transfers.quarantine({ status: "active" })).items[0]!;

    await writeFile(original, "collision", "utf8");
    await harness.service.restore(quarantined.id, "test-user", "RESTORE retry.jpg");
    await harness.worker.runOnce();
    expect(await harness.transfers.quarantineItem(quarantined.id)).toMatchObject({
      status: "restore-blocked",
      error: { code: "DESTINATION_COLLISION" },
    });
    await expect(readFile(
      path.join(harness.sourcePath, ...quarantined.quarantinedRelativePath.split("/")),
      "utf8",
    )).resolves.toBe("quarantined payload");

    await rm(original);
    await harness.service.restore(quarantined.id, "test-user", "RESTORE retry.jpg");
    await harness.worker.runOnce();
    await expect(readFile(original, "utf8")).resolves.toBe("quarantined payload");
    expect(await harness.transfers.quarantineItem(quarantined.id)).toMatchObject({
      status: "restored",
    });
  });
});

async function createHarness(
  options: { readonly capacityProbe?: TransferCapacityProbe } = {},
): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-transfer-"));
  const libraryPath = path.join(directory, "library");
  const sourcePath = path.join(directory, "source");
  const statePath = path.join(directory, "state");
  await Promise.all([mkdir(libraryPath), mkdir(sourcePath), mkdir(statePath)]);
  const enrollmentStore = new JsonlRootEnrollmentStore(path.join(statePath, "enrollments.jsonl"));
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  const volumes = new TestVolumeIdentityProvider();
  const enrollment = new RootEnrollmentService(canonicalizer, volumes, enrollmentStore);
  const libraryProposal = await enrollment.propose({
    role: "library", path: libraryPath, displayName: "Destination library",
  });
  const sourceProposal = await enrollment.propose({
    role: "ingest-source", path: sourcePath, displayName: "Camera source", ingestSourceKind: "sd-card",
  });
  const library = await enrollment.approve(libraryProposal.proposalId, "test-user");
  const source = await enrollment.approve(sourceProposal.proposalId, "test-user");
  await enrollment.setLibraryWriteAccess(library.id as never, true, "test-user");

  const catalog = new SqliteInventoryCatalog({ databasePath: path.join(statePath, "inventory.sqlite") });
  const intelligence = new SqliteIntelligenceStore({ databasePath: path.join(statePath, "inventory.sqlite") });
  const organization = new SqliteOrganizationStore({ databasePath: path.join(statePath, "organization.sqlite") });
  await organization.setMutationMode("live", "test-user");
  const transfers = new SqliteTransferStore(path.join(statePath, "transfers.sqlite"));
  const queue = new SqlitePersistentJobQueue({
    databasePath: path.join(statePath, "jobs.sqlite"),
    definitions: [
      INGEST_ANALYSIS_JOB_DEFINITION,
      INGEST_TRANSFER_JOB_DEFINITION,
      QUARANTINE_RESTORE_JOB_DEFINITION,
      INVENTORY_SCAN_JOB_DEFINITION,
    ],
  });
  const boundary = new PathBoundary(process.platform === "win32" ? "win32" : "posix");
  const rootResolver = new ReadOnlyRootPathResolver(canonicalizer, boundary);
  const guard = new TransferRootGuard(
    enrollmentStore,
    canonicalizer,
    volumes,
    rootResolver,
    boundary,
  );
  const platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix";
  const transferHandler = options.capacityProbe === undefined
    ? new IngestTransferJobHandler(
        guard, transfers, organization, enrollmentStore, intelligence, queue,
      )
    : new IngestTransferJobHandler(
        guard,
        transfers,
        organization,
        enrollmentStore,
        intelligence,
        queue,
        () => new Date(),
        platform,
        options.capacityProbe,
      );
  const worker = new PersistentLocalWorker({
    id: "transfer-test-worker" as WorkerId,
    queue,
    handlers: [
      new IngestAnalysisJobHandler(guard, transfers, intelligence),
      transferHandler,
      new QuarantineRestoreJobHandler(guard, transfers, organization, enrollmentStore),
    ],
  });
  const service = new TransferService(
    transfers,
    queue,
    enrollmentStore,
    organization,
    catalog,
    intelligence,
  );
  return {
    directory, libraryPath, sourcePath, enrollment, library, source,
    organization, transfers, queue, service, worker,
    cleanup: async () => {
      transfers.close();
      organization.close();
      intelligence.close();
      catalog.close();
      queue.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function trackedHarness(
  options: { readonly capacityProbe?: TransferCapacityProbe } = {},
): Promise<Harness> {
  const harness = await createHarness(options);
  harnesses.push(harness);
  return harness;
}

function transferStagingPath(
  libraryPath: string,
  planId: string,
  itemId: string,
): string {
  const plan = createHash("sha256").update(planId).digest("hex").slice(0, 24);
  const item = createHash("sha256").update(itemId).digest("hex");
  return path.join(
    libraryPath,
    ".local-librarian",
    "transfer-staging",
    plan,
    `${item}.part`,
  );
}

async function pathExists(value: string): Promise<boolean> {
  try { await access(value); return true; } catch { return false; }
}
