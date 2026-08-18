import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkerId } from "../../src/domain/index.js";
import {
  DIAGNOSTIC_COUNT_JOB_DEFINITION,
  IdempotencyConflictError,
  SqlitePersistentJobQueue,
  type JobDefinition,
  type JobSubmission,
} from "../../src/jobs/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqlitePersistentJobQueue", () => {
  it("durably submits immediately and deduplicates concurrent idempotent requests", async () => {
    const databasePath = testDatabasePath();
    const first = queue(databasePath);
    const second = queue(databasePath);

    const [a, b] = await Promise.all([
      first.submit(submission("same-key")),
      second.submit(submission("same-key")),
    ]);

    expect(a.jobId).toBe(b.jobId);
    expect([a.deduplicatedSubmission, b.deduplicatedSubmission].sort()).toEqual([
      false,
      true,
    ]);
    expect(await first.status(a.jobId)).toMatchObject({ status: "queued" });
    expect((await first.list()).items).toHaveLength(1);

    first.close();
    second.close();

    const reopened = queue(databasePath);
    expect(await reopened.status(a.jobId)).toMatchObject({ status: "queued" });
    reopened.close();
  });

  it("rejects reusing an idempotency key for different work", async () => {
    const store = queue(testDatabasePath());
    await store.submit(submission("conflict", 10));

    await expect(store.submit(submission("conflict", 11))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    store.close();
  });

  it("allows exactly one concurrent worker to claim a queued job", async () => {
    const databasePath = testDatabasePath();
    const client = queue(databasePath);
    const other = queue(databasePath);
    const receipt = await client.submit(submission("claim-once"));

    const leases = await Promise.all([
      client.claimNext("worker-a" as WorkerId, ["diagnostic.count"]),
      other.claimNext("worker-b" as WorkerId, ["diagnostic.count"]),
    ]);

    expect(leases.filter((lease) => lease !== undefined)).toHaveLength(1);
    expect(await client.status(receipt.jobId)).toMatchObject({ status: "running" });
    client.close();
    other.close();
  });

  it("recovers an expired resumable lease from its durable checkpoint", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = queue(testDatabasePath(), () => now);
    const receipt = await store.submit(submission("resume-recovery", 10, 3, 100));
    const lease = await store.claimNext("worker-a" as WorkerId);
    expect(lease).toBeDefined();
    await store.saveCheckpoint(lease!, { completedIterations: 4 });

    now = new Date("2026-01-01T00:00:00.101Z");
    const report = await store.recoverExpiredLeases(now.toISOString());
    const recovered = await store.get(receipt.jobId);

    expect(report).toMatchObject({
      expiredLeaseCount: 1,
      requeuedJobIds: [receipt.jobId],
      failedJobIds: [],
    });
    expect(recovered).toMatchObject({
      status: "queued",
      checkpoint: { completedIterations: 4 },
      attempts: [{ outcome: "lease-expired" }],
    });
    store.close();
  });

  it("clears checkpoints when a restart-only job lease expires", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const restartDefinition: JobDefinition = {
      ...DIAGNOSTIC_COUNT_JOB_DEFINITION,
      recoveryMode: "restart",
    };
    const databasePath = testDatabasePath();
    const store = new SqlitePersistentJobQueue({
      databasePath,
      definitions: [restartDefinition],
      clock: () => now,
    });
    const receipt = await store.submit(submission("restart-recovery", 10, 3, 100));
    const lease = await store.claimNext("worker-a" as WorkerId);
    await store.saveCheckpoint(lease!, { completedIterations: 4 });
    now = new Date("2026-01-01T00:00:00.101Z");

    await store.recoverExpiredLeases(now.toISOString());
    const recovered = await store.get(receipt.jobId);
    expect(recovered?.status).toBe("queued");
    expect(recovered?.checkpoint).toBeUndefined();
    store.close();
  });

  it("honors maximum attempts during repeated lease-expiration recovery", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = queue(testDatabasePath(), () => now);
    const receipt = await store.submit(submission("attempt-limit", 10, 2, 100));

    await store.claimNext("worker-a" as WorkerId);
    now = new Date("2026-01-01T00:00:00.101Z");
    await store.recoverExpiredLeases(now.toISOString());
    await store.claimNext("worker-b" as WorkerId);
    now = new Date("2026-01-01T00:00:00.202Z");
    const report = await store.recoverExpiredLeases(now.toISOString());

    expect(report.failedJobIds).toEqual([receipt.jobId]);
    expect(await store.status(receipt.jobId)).toMatchObject({ status: "failed" });
    expect(await store.claimNext("worker-c" as WorkerId)).toBeUndefined();
    store.close();
  });

  it("keeps job history append-only and pages it by sequence", async () => {
    const store = queue(testDatabasePath());
    const receipt = await store.submit(submission("history"));
    await store.requestPause(receipt.jobId, "test");
    await store.resume(receipt.jobId, "test");

    const firstPage = await store.history(receipt.jobId, 0, 2);
    expect(firstPage.events.map((event) => event.kind)).toEqual([
      "submitted",
      "pause-requested",
    ]);
    expect(firstPage.nextSequence).toBe(2);
    const secondPage = await store.history(receipt.jobId, firstPage.nextSequence, 10);
    expect(secondPage.events.map((event) => event.kind)).toEqual([
      "paused",
      "resume-requested",
    ]);
    store.close();
  });
});

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
  const directory = mkdtempSync(join(tmpdir(), "local-librarian-jobs-"));
  temporaryDirectories.push(directory);
  return join(directory, "jobs.sqlite");
}

