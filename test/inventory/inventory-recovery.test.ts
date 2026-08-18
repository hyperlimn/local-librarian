import { writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject, WorkerId } from "../../src/domain/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
  type JobExecutionContext,
  type JobLease,
  type JobProgress,
  type WorkerControlSignal,
} from "../../src/jobs/index.js";
import {
  INVENTORY_SCAN_JOB_DEFINITION,
  InventoryScanJobHandler,
} from "../../src/scanner/index.js";
import {
  createCatalog,
  createInventoryFixture,
  createInventoryTools,
  createInventoryWorker,
  createJobQueue,
  createRootGuard,
  type InventoryTestFixture,
} from "./test-helpers.js";

const fixtures: InventoryTestFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("inventory.scan controls and recovery", () => {
  it("cooperatively pauses and resumes from its durable frontier", async () => {
    const fixture = await fixtureWithFiles(30);
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const receipt = await tools.scan({ rootId: fixture.root.id, idempotencyKey: "pause" });
    const worker = createInventoryWorker(queue, catalog, fixture.store, {
      batchSize: 2,
      afterBatch: () => delay(5),
    });

    const firstRun = worker.runOnce();
    await waitFor(async () => ((await queue.status(receipt.jobId))?.progress?.completedUnits ?? 0) >= 2);
    await queue.requestPause(receipt.jobId, "test");
    await firstRun;

    expect(await queue.status(receipt.jobId)).toMatchObject({ status: "paused" });
    const pausedSummary = await tools.summary(fixture.root.id);
    expect(pausedSummary.latestScan).toMatchObject({
      status: "paused",
      checkpoint: { scanId: expect.any(String), currentRelativePath: "." },
    });
    const observedBeforeResume = pausedSummary.latestScan!.counts.recordsObserved;
    expect(observedBeforeResume).toBeGreaterThan(0);
    expect(observedBeforeResume).toBeLessThan(30);

    await queue.resume(receipt.jobId, "test");
    await worker.runOnce();
    expect(await queue.status(receipt.jobId)).toMatchObject({ status: "completed" });
    expect((await tools.summary(fixture.root.id)).latestScan).toMatchObject({
      status: "completed",
      counts: { filesDiscovered: 30, recordsObserved: 30 },
    });
    expect((await tools.list(fixture.root.id, { limit: 100 })).items).toHaveLength(30);
    catalog.close();
    queue.close();
  });

  it("cooperatively cancels without traversing the remaining frontier", async () => {
    const fixture = await fixtureWithFiles(30);
    const queue = createJobQueue(fixture.jobsPath);
    const catalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(queue, catalog, fixture);
    const receipt = await tools.scan({ rootId: fixture.root.id, idempotencyKey: "cancel" });
    const worker = createInventoryWorker(queue, catalog, fixture.store, {
      batchSize: 2,
      afterBatch: () => delay(5),
    });

    const run = worker.runOnce();
    await waitFor(async () => ((await queue.status(receipt.jobId))?.progress?.completedUnits ?? 0) >= 2);
    await queue.cancel(receipt.jobId, "test");
    await run;

    expect(await queue.status(receipt.jobId)).toMatchObject({ status: "cancelled" });
    expect((await tools.summary(fixture.root.id)).latestScan).toMatchObject({
      status: "cancelled",
    });
    expect((await tools.summary(fixture.root.id)).latestScan!.counts.filesDiscovered).toBeLessThan(30);
    catalog.close();
    queue.close();
  });

  it("recovers a crashed worker from both the job checkpoint and catalog frontier", async () => {
    const fixture = await fixtureWithFiles(15);
    let now = new Date("2026-08-18T12:00:00.000Z");
    const originalQueue = new SqlitePersistentJobQueue({
      databasePath: fixture.jobsPath,
      definitions: [INVENTORY_SCAN_JOB_DEFINITION],
      clock: () => now,
    });
    const originalCatalog = createCatalog(fixture.inventoryPath);
    const tools = createInventoryTools(originalQueue, originalCatalog, fixture);
    const receipt = await tools.scan({
      rootId: fixture.root.id,
      idempotencyKey: "crash-recovery",
      leaseDurationMilliseconds: 100,
    });
    const lease = await originalQueue.claimNext("crashed-worker" as WorkerId, [
      "inventory.scan",
    ]);
    const job = await originalQueue.loadLeasedJob(lease!);
    const context = new DirectExecutionContext(originalQueue, lease!);
    let crashed = false;
    const crashingHandler = new InventoryScanJobHandler(
      createRootGuard(fixture.store),
      originalCatalog,
      {
        batchSize: 3,
        clock: () => now,
        afterBatch: () => {
          if (!crashed) {
            crashed = true;
            throw new Error("synthetic abrupt process exit");
          }
          return Promise.resolve();
        },
      },
    );

    await expect(crashingHandler.run(job, context)).rejects.toThrow(
      "synthetic abrupt process exit",
    );
    expect(await originalQueue.status(receipt.jobId)).toMatchObject({
      status: "running",
      progress: { completedUnits: 3 },
    });
    expect((await tools.summary(fixture.root.id)).latestScan).toMatchObject({
      status: "failed",
      counts: { filesDiscovered: 3 },
    });
    originalCatalog.close();
    originalQueue.close();

    now = new Date("2026-08-18T12:00:00.101Z");
    const restartedQueue = new SqlitePersistentJobQueue({
      databasePath: fixture.jobsPath,
      definitions: [INVENTORY_SCAN_JOB_DEFINITION],
      clock: () => now,
    });
    const restartedCatalog = createCatalog(fixture.inventoryPath);
    const restartedWorker = new PersistentLocalWorker({
      id: "restarted-worker" as WorkerId,
      queue: restartedQueue,
      clock: () => now,
      handlers: [
        new InventoryScanJobHandler(
          createRootGuard(fixture.store),
          restartedCatalog,
          { batchSize: 3, clock: () => now },
        ),
      ],
    });

    await restartedWorker.runOnce();
    expect(await restartedQueue.status(receipt.jobId)).toMatchObject({ status: "completed" });
    expect((await restartedQueue.get(receipt.jobId))?.attempts).toMatchObject([
      { outcome: "lease-expired" },
      { outcome: "completed" },
    ]);
    expect((await restartedCatalog.summary(fixture.root.id)).latestScan).toMatchObject({
      status: "completed",
      counts: { filesDiscovered: 15, recordsObserved: 15 },
    });
    expect((await restartedCatalog.list(fixture.root.id, { limit: 100 })).items).toHaveLength(15);
    restartedCatalog.close();
    restartedQueue.close();
  });
});

class DirectExecutionContext implements JobExecutionContext {
  #lease: JobLease;
  #checkpoint: JsonObject | undefined;

  public constructor(
    private readonly queue: SqlitePersistentJobQueue,
    lease: JobLease,
  ) {
    this.#lease = lease;
    this.#checkpoint = lease.checkpoint;
  }

  public get lease(): JobLease {
    return this.#lease;
  }

  public get checkpoint(): JsonObject | undefined {
    return this.#checkpoint;
  }

  public async reportProgress(progress: JobProgress): Promise<void> {
    this.#lease = await this.queue.heartbeat(this.#lease, progress);
  }

  public async saveCheckpoint(checkpoint: JsonObject): Promise<void> {
    await this.queue.saveCheckpoint(this.#lease, checkpoint);
    this.#checkpoint = checkpoint;
  }

  public controlSignal(): Promise<WorkerControlSignal> {
    return this.queue.controlSignal(this.#lease);
  }

  public async throwIfControlRequested(): Promise<void> {
    if ((await this.controlSignal()) !== "continue") {
      throw new Error("Unexpected control request in crash simulation.");
    }
  }
}

async function fixtureWithFiles(count: number): Promise<InventoryTestFixture> {
  const fixture = await createInventoryFixture();
  fixtures.push(fixture);
  for (let index = 0; index < count; index += 1) {
    await writeFile(path.join(fixture.rootPath, `file-${index}.txt`), "x", "utf8");
  }
  return fixture;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for inventory progress.");
    await delay(2);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
