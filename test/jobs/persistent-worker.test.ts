import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkerId } from "../../src/domain/index.js";
import {
  DIAGNOSTIC_COUNT_JOB_DEFINITION,
  DiagnosticCountJobHandler,
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
  type JobExecutionContext,
  type JobHandler,
  type JobSubmission,
  type PersistentJobRecord,
} from "../../src/jobs/index.js";
import { DiagnosticJobTools } from "../../src/mcp/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PersistentLocalWorker", () => {
  it("finishes independently after an immediate MCP-facing submission", async () => {
    const databasePath = testDatabasePath();
    const clientQueue = queue(databasePath);
    const workerQueue = queue(databasePath);
    const tools = new DiagnosticJobTools(clientQueue);
    const receipt = await tools.submit({ iterations: 8, idempotencyKey: "lifecycle" });

    expect(receipt.status).toBe("queued");
    expect(await tools.status(receipt.jobId)).toMatchObject({ status: "queued" });

    const worker = diagnosticWorker(workerQueue, "worker-one");
    expect(await worker.runOnce()).toBe("worked");

    expect(await tools.status(receipt.jobId)).toMatchObject({
      status: "completed",
      progress: { completedUnits: 8, totalUnits: 8 },
    });
    expect(await tools.result(receipt.jobId)).toMatchObject({
      status: "completed",
      result: { summary: { counted: 8, iterations: 8 } },
    });
    const history = await tools.history(receipt.jobId);
    expect(history.events.map((event) => event.kind)).toContain("checkpoint-saved");
    expect(history.events.at(-1)?.kind).toBe("completed");
    clientQueue.close();
    workerQueue.close();
  });

  it("cooperatively pauses, persists its checkpoint, and resumes", async () => {
    const databasePath = testDatabasePath();
    const client = queue(databasePath);
    const workerQueue = queue(databasePath);
    const receipt = await client.submit(submission("pause-resume", 100));
    const worker = diagnosticWorker(workerQueue, "worker-pause", 2);

    const firstRun = worker.runOnce();
    await waitFor(async () => (await client.status(receipt.jobId))?.status === "running");
    await client.requestPause(receipt.jobId, "test");
    await firstRun;

    const paused = await client.get(receipt.jobId);
    expect(paused?.status).toBe("paused");
    expect(paused?.checkpoint?.["completedIterations"]).toBeTypeOf("number");
    await client.resume(receipt.jobId, "test");
    await worker.runOnce();
    expect(await client.status(receipt.jobId)).toMatchObject({ status: "completed" });
    client.close();
    workerQueue.close();
  });

  it("cooperatively cancels a running job", async () => {
    const databasePath = testDatabasePath();
    const client = queue(databasePath);
    const workerQueue = queue(databasePath);
    const receipt = await client.submit(submission("cancel", 100));
    const worker = diagnosticWorker(workerQueue, "worker-cancel", 2);

    const run = worker.runOnce();
    await waitFor(async () => (await client.status(receipt.jobId))?.status === "running");
    await client.cancel(receipt.jobId, "test");
    await run;

    expect(await client.status(receipt.jobId)).toMatchObject({ status: "cancelled" });
    expect((await client.result(receipt.jobId))?.result).toBeUndefined();
    client.close();
    workerQueue.close();
  });

  it("recovers from a checkpoint after the original worker process disappears", async () => {
    let firstProcessTime = new Date("2026-01-01T00:00:00.000Z");
    const databasePath = testDatabasePath();
    const original = queue(databasePath, () => firstProcessTime);
    const receipt = await original.submit(submission("worker-restart", 10, 3, 100));
    const abandonedLease = await original.claimNext("worker-before-crash" as WorkerId);
    await original.saveCheckpoint(abandonedLease!, { completedIterations: 6 });
    original.close();

    firstProcessTime = new Date("2026-01-01T00:00:00.101Z");
    const restarted = queue(databasePath, () => firstProcessTime);
    const worker = new PersistentLocalWorker({
      id: "worker-after-crash" as WorkerId,
      queue: restarted,
      handlers: [new DiagnosticCountJobHandler({ delayMilliseconds: 0, checkpointEvery: 1, progressEvery: 1, clock: () => firstProcessTime })],
      clock: () => firstProcessTime,
    });

    await worker.runOnce();
    const record = await restarted.get(receipt.jobId);
    expect(record).toMatchObject({
      status: "completed",
      result: { summary: { counted: 10 } },
      attempts: [
        { outcome: "lease-expired" },
        { outcome: "completed" },
      ],
    });
    restarted.close();
  });

  it("retries handler failures only up to the configured limit", async () => {
    const databasePath = testDatabasePath();
    const store = queue(databasePath);
    const receipt = await store.submit(submission("handler-retry", 10, 2));
    const failingHandler: JobHandler = {
      kind: "diagnostic.count",
      recoveryMode: "resume-from-checkpoint",
      run(_job: PersistentJobRecord, _context: JobExecutionContext) {
        return Promise.reject(new Error("intentional diagnostic failure"));
      },
    };
    const worker = new PersistentLocalWorker({
      id: "worker-failure" as WorkerId,
      queue: store,
      handlers: [failingHandler],
    });

    await worker.runOnce();
    expect(await store.status(receipt.jobId)).toMatchObject({ status: "queued" });
    await worker.runOnce();
    expect(await store.status(receipt.jobId)).toMatchObject({ status: "failed" });
    expect(await worker.runOnce()).toBe("idle");
    expect((await store.get(receipt.jobId))?.attempts).toHaveLength(2);
    store.close();
  });

  it("does not duplicate work through the diagnostic MCP facade", async () => {
    const store = queue(testDatabasePath());
    const tools = new DiagnosticJobTools(store);
    const first = await tools.submit({ iterations: 3, idempotencyKey: "mcp-idem" });
    const duplicate = await tools.submit({ iterations: 3, idempotencyKey: "mcp-idem" });

    expect(duplicate).toMatchObject({
      jobId: first.jobId,
      deduplicatedSubmission: true,
    });
    expect((await store.list()).items).toHaveLength(1);
    store.close();
  });
});

function diagnosticWorker(
  queueInstance: SqlitePersistentJobQueue,
  id: string,
  delayMilliseconds = 0,
): PersistentLocalWorker {
  return new PersistentLocalWorker({
    id: id as WorkerId,
    queue: queueInstance,
    handlers: [new DiagnosticCountJobHandler({
      delayMilliseconds,
      checkpointEvery: 1,
      progressEvery: 1,
    })],
  });
}

function queue(databasePath: string, clock?: () => Date): SqlitePersistentJobQueue {
  return new SqlitePersistentJobQueue({
    databasePath,
    definitions: [DIAGNOSTIC_COUNT_JOB_DEFINITION],
    ...(clock === undefined ? {} : { clock }),
  });
}

function submission(
  idempotencyKey: string,
  iterations = 10,
  maximumAttempts = 3,
  leaseDurationMilliseconds = 30_000,
): JobSubmission {
  return {
    kind: "diagnostic.count",
    payload: { iterations },
    priority: 0,
    idempotencyKey,
    requestedBy: "test",
    controlPolicy: {
      pauseMode: "checkpoint",
      cancellationMode: "cooperative",
      maximumAttempts,
      leaseDurationMilliseconds,
    },
  };
}

function testDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "local-librarian-worker-"));
  temporaryDirectories.push(directory);
  return join(directory, "jobs.sqlite");
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for job state.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

