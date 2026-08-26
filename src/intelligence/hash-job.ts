import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

import type {
  ApprovedLibraryRoot,
  JsonObject,
  LibraryRootId,
} from "../domain/index.js";
import {
  JobHandlerFailure,
  JobPauseRequested,
  type JobDefinition,
  type JobExecutionContext,
  type JobHandler,
  type PersistentJobRecord,
  type StructuredJobResult,
} from "../jobs/index.js";
import type { InventoryRootGuard } from "../scanner/index.js";
import type { ReadOnlyRootPathResolver } from "../safety/index.js";
import type { HashTask, NeedsReviewItem } from "./types.js";
import type { SqliteIntelligenceStore } from "./intelligence-store.js";

export const DUPLICATE_DETECTION_JOB_DEFINITION: JobDefinition = {
  kind: "duplicates.detect",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validateCandidatePayload,
};

export const CONTENT_HASH_JOB_DEFINITION: JobDefinition = {
  kind: "content.hash",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validateHashPayload,
};

interface CandidatePayload {
  readonly rootId: string;
  readonly scanId: string;
}

interface HashPayload extends CandidatePayload {
  readonly rootIdentityKey: string;
  readonly scope: "duplicate-candidates" | "all";
}

interface HashCheckpoint {
  readonly phase: "hash" | "exact-groups";
  readonly initialized: boolean;
  readonly afterRelativePath?: string;
  readonly afterRecordId?: string;
  readonly afterDigest?: string;
  readonly afterByteLength?: number;
  readonly processed: number;
  readonly reused: number;
  readonly failed: number;
  readonly completedBytes: number;
}

export class DuplicateCandidateJobHandler implements JobHandler {
  public readonly kind = "duplicates.detect" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;

  public constructor(
    private readonly store: SqliteIntelligenceStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    validateCandidatePayload(job.payload);
    const payload = job.payload as unknown as CandidatePayload;
    const checkpoint = candidateCheckpoint(context.checkpoint);
    const now = this.clock().toISOString();
    try {
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "candidate-duplicates",
        status: "running",
        jobId: job.id,
        processed: checkpoint.processed,
        details: { strategy: "same-byte-length" },
        updatedAt: now,
      });
      let afterByteLength = checkpoint.afterByteLength;
      let processed = checkpoint.processed;
      if (!checkpoint.initialized) {
        await this.store.clearDuplicateGroups(payload.scanId, "candidate");
        await context.saveCheckpoint({
          initialized: true,
          processed,
          ...(afterByteLength === undefined ? {} : { afterByteLength }),
        });
      }
      for (;;) {
        await context.throwIfControlRequested();
        const groups = await this.store.candidateSizeGroups(
          payload.scanId,
          afterByteLength ?? -1,
          250,
        );
        if (groups.length === 0) break;
        for (const group of groups) {
          await context.throwIfControlRequested();
          await this.store.upsertCandidateGroup(
            payload.rootId,
            payload.scanId,
            group,
            this.clock().toISOString(),
          );
          afterByteLength = group.byteLength;
          processed += 1;
        }
        const lastByteLength = groups.at(-1)!.byteLength;
        afterByteLength = lastByteLength;
        const updatedAt = this.clock().toISOString();
        await context.saveCheckpoint({ initialized: true, afterByteLength: lastByteLength, processed });
        await context.reportProgress({
          phase: "candidate-duplicates",
          completedUnits: processed,
          unit: "items",
          message: `Persisted ${processed.toLocaleString()} duplicate-size candidate groups.`,
          metrics: { candidateGroups: processed, lastByteLength },
          updatedAt,
        });
        await this.store.setStage({
          rootId: payload.rootId,
          scanId: payload.scanId,
          stage: "candidate-duplicates",
          status: "running",
          jobId: job.id,
          processed,
          details: { strategy: "same-byte-length", lastByteLength },
          updatedAt,
        });
      }
      const completedAt = this.clock().toISOString();
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "candidate-duplicates",
        status: "completed",
        jobId: job.id,
        processed,
        total: processed,
        details: { strategy: "same-byte-length" },
        updatedAt: completedAt,
      });
      return {
        summary: { rootId: payload.rootId, scanId: payload.scanId, candidateGroups: processed },
        artifacts: [{ kind: "catalog-query", id: payload.scanId }],
        completedAt,
      };
    } catch (error) {
      await this.recordStageInterruption(payload, job.id, checkpoint.processed, error);
      throw error;
    }
  }

  private async recordStageInterruption(
    payload: CandidatePayload,
    jobId: string,
    processed: number,
    error: unknown,
  ): Promise<void> {
    const cooperative = cooperativeStatus(error);
    await this.store.setStage({
      rootId: payload.rootId,
      scanId: payload.scanId,
      stage: "candidate-duplicates",
      status: cooperative ?? "failed",
      jobId,
      processed,
      details: { strategy: "same-byte-length" },
      ...(cooperative === undefined
        ? { error: { code: "DUPLICATE_CANDIDATE_DETECTION_FAILED", message: errorMessage(error) } }
        : {}),
      updatedAt: this.clock().toISOString(),
    });
  }
}

export class ContentHashJobHandler implements JobHandler {
  public readonly kind = "content.hash" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;

  public constructor(
    private readonly rootGuard: InventoryRootGuard,
    private readonly rootResolver: ReadOnlyRootPathResolver,
    private readonly store: SqliteIntelligenceStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    validateHashPayload(job.payload);
    const payload = job.payload as unknown as HashPayload;
    let checkpoint = hashCheckpoint(context.checkpoint);
    let root: ApprovedLibraryRoot;
    try {
      const settings = await this.store.settings();
      if (settings.pauseHeavyWork) {
        await this.store.setStage({
          rootId: payload.rootId,
          scanId: payload.scanId,
          stage: "content-identity",
          status: "paused",
          jobId: job.id,
          processed: checkpoint.processed,
          details: { reason: "Heavy work is paused in Settings." },
          updatedAt: this.clock().toISOString(),
        });
        throw new JobPauseRequested();
      }
      root = await this.rootGuard.validateForScan(
        payload.rootId as LibraryRootId,
        payload.rootIdentityKey,
      );
      const totals = await this.store.hashTaskTotals(payload.scanId, payload.scope);
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "content-identity",
        status: "running",
        jobId: job.id,
        processed: checkpoint.processed,
        total: totals.files,
        details: {
          algorithm: "sha256",
          scope: payload.scope,
          totalBytes: totals.bytes,
          reused: checkpoint.reused,
          failed: checkpoint.failed,
        },
        updatedAt: this.clock().toISOString(),
      });

      if (checkpoint.phase === "hash") {
        checkpoint = await this.hashFiles(root, payload, job.id, context, checkpoint, totals);
      }
      checkpoint = await this.buildExactGroups(payload, job.id, context, checkpoint);
      const completedAt = this.clock().toISOString();
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "content-identity",
        status: "completed",
        jobId: job.id,
        processed: checkpoint.processed,
        total: totals.files,
        details: {
          algorithm: "sha256",
          scope: payload.scope,
          totalBytes: totals.bytes,
          completedBytes: checkpoint.completedBytes,
          reused: checkpoint.reused,
          failed: checkpoint.failed,
        },
        updatedAt: completedAt,
      });
      return {
        summary: {
          rootId: payload.rootId,
          scanId: payload.scanId,
          algorithm: "sha256",
          processed: checkpoint.processed,
          reused: checkpoint.reused,
          failed: checkpoint.failed,
          completedBytes: checkpoint.completedBytes,
        },
        artifacts: [{ kind: "catalog-query", id: payload.scanId }],
        completedAt,
      };
    } catch (error) {
      const cooperative = cooperativeStatus(error);
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "content-identity",
        status: cooperative ?? "failed",
        jobId: job.id,
        processed: checkpoint.processed,
        details: {
          algorithm: "sha256",
          scope: payload.scope,
          reused: checkpoint.reused,
          failed: checkpoint.failed,
          completedBytes: checkpoint.completedBytes,
        },
        ...(cooperative === undefined
          ? { error: { code: "CONTENT_HASH_FAILED", message: errorMessage(error) } }
          : {}),
        updatedAt: this.clock().toISOString(),
      });
      if (cooperative !== undefined) throw error;
      if (error instanceof JobHandlerFailure) throw error;
      throw new JobHandlerFailure("CONTENT_HASH_FAILED", errorMessage(error), true, {
        rootId: payload.rootId,
        scanId: payload.scanId,
      });
    }
  }

  private async hashFiles(
    root: ApprovedLibraryRoot,
    payload: HashPayload,
    jobId: string,
    context: JobExecutionContext,
    initial: HashCheckpoint,
    totals: { readonly files: number; readonly bytes: number },
  ): Promise<HashCheckpoint> {
    let checkpoint = initial;
    const settings = await this.store.settings();
    const concurrency = settings.throughputMode === "disk-friendly"
      ? 1
      : Math.min(
          settings.maximumHashingWorkers,
          settings.throughputMode === "balanced" ? 2 : settings.maximumHashingWorkers,
        );
    const highWaterMark = settings.throughputMode === "maximum"
      ? 8 * 1024 * 1024
      : settings.throughputMode === "balanced"
        ? 4 * 1024 * 1024
        : 1024 * 1024;
    for (;;) {
      await context.throwIfControlRequested();
      const tasks = await this.store.hashTasks(
        payload.scanId,
        payload.scope,
        Math.max(25, concurrency * 4),
        checkpoint.afterRelativePath,
        checkpoint.afterRecordId,
      );
      if (tasks.length === 0) break;
      for (let index = 0; index < tasks.length; index += concurrency) {
        await context.throwIfControlRequested();
        await this.rootGuard.loadApprovedLibrary(root.id, root.identity.key);
        const chunk = tasks.slice(index, index + concurrency);
        let inFlightBytes = 0;
        let reportChain = Promise.resolve();
        const outcomes = await Promise.all(chunk.map(async (task) => {
          const prior = await this.store.hashForRecord(task.recordId);
          if (prior !== undefined) {
            return { task, reused: prior.verificationState === "reused", failed: false, bytes: task.byteLength };
          }
          const reusable = await this.store.reusableHash(task);
          if (reusable !== undefined) {
            await this.store.saveHash(
              task,
              reusable.digestHex,
              this.clock().toISOString(),
              "reused",
              reusable.recordId,
            );
            return { task, reused: true, failed: false, bytes: task.byteLength };
          }
          try {
            const digest = await this.hashOne(root, task, highWaterMark, (delta) => {
              inFlightBytes += delta;
              if (inFlightBytes < 64 * 1024 * 1024) return;
              const bytes = inFlightBytes;
              inFlightBytes = 0;
              reportChain = reportChain.then(() => context.reportProgress({
                phase: "content-identity",
                completedUnits: Math.min(totals.bytes, checkpoint.completedBytes + bytes),
                totalUnits: totals.bytes,
                unit: "bytes",
                percent: totals.bytes === 0
                  ? 100
                  : Math.min(99, Math.floor(((checkpoint.completedBytes + bytes) / totals.bytes) * 100)),
                message: `Hashing ${task.relativePath}`,
                metrics: {
                  filesProcessed: checkpoint.processed,
                  filesTotal: totals.files,
                  algorithm: "sha256",
                },
                updatedAt: this.clock().toISOString(),
              }));
            });
            await this.store.saveHash(task, digest, this.clock().toISOString(), "verified");
            return { task, reused: false, failed: false, bytes: task.byteLength };
          } catch (error) {
            await this.recordHashFailure(task, error);
            return { task, reused: false, failed: true, bytes: 0 };
          }
        }));
        await reportChain;
        for (const outcome of outcomes) {
          checkpoint = {
            ...checkpoint,
            afterRelativePath: outcome.task.relativePath,
            afterRecordId: outcome.task.recordId,
            processed: checkpoint.processed + 1,
            reused: checkpoint.reused + (outcome.reused ? 1 : 0),
            failed: checkpoint.failed + (outcome.failed ? 1 : 0),
            completedBytes: checkpoint.completedBytes + outcome.bytes,
          };
        }
        await context.saveCheckpoint(checkpointToJson(checkpoint));
        const updatedAt = this.clock().toISOString();
        await context.reportProgress({
          phase: "content-identity",
          completedUnits: checkpoint.completedBytes,
          totalUnits: totals.bytes,
          unit: "bytes",
          percent: totals.bytes === 0
            ? 100
            : Math.min(99, Math.floor((checkpoint.completedBytes / totals.bytes) * 100)),
          message: `Identified ${checkpoint.processed.toLocaleString()} of ${totals.files.toLocaleString()} files.`,
          metrics: {
            filesProcessed: checkpoint.processed,
            filesTotal: totals.files,
            hashesReused: checkpoint.reused,
            failures: checkpoint.failed,
            concurrency,
            algorithm: "sha256",
          },
          updatedAt,
        });
        await this.store.setStage({
          rootId: payload.rootId,
          scanId: payload.scanId,
          stage: "content-identity",
          status: "running",
          jobId,
          processed: checkpoint.processed,
          total: totals.files,
          details: {
            algorithm: "sha256",
            scope: payload.scope,
            totalBytes: totals.bytes,
            completedBytes: checkpoint.completedBytes,
            reused: checkpoint.reused,
            failed: checkpoint.failed,
          },
          updatedAt,
        });
      }
    }
    checkpoint = {
      phase: "exact-groups",
      initialized: false,
      ...(checkpoint.afterRelativePath === undefined
        ? {}
        : { afterRelativePath: checkpoint.afterRelativePath }),
      ...(checkpoint.afterRecordId === undefined ? {} : { afterRecordId: checkpoint.afterRecordId }),
      processed: checkpoint.processed,
      reused: checkpoint.reused,
      failed: checkpoint.failed,
      completedBytes: checkpoint.completedBytes,
    };
    await context.saveCheckpoint(checkpointToJson(checkpoint));
    return checkpoint;
  }

  private async buildExactGroups(
    payload: HashPayload,
    jobId: string,
    context: JobExecutionContext,
    initial: HashCheckpoint,
  ): Promise<HashCheckpoint> {
    let checkpoint = initial;
    if (!checkpoint.initialized) {
      await this.store.clearDuplicateGroups(payload.scanId, "exact");
      checkpoint = { ...checkpoint, initialized: true };
      await context.saveCheckpoint(checkpointToJson(checkpoint));
    }
    let groupsProcessed = 0;
    for (;;) {
      await context.throwIfControlRequested();
      const groups = await this.store.exactHashGroups(
        payload.scanId,
        checkpoint.afterDigest ?? "",
        checkpoint.afterByteLength ?? -1,
        250,
      );
      if (groups.length === 0) break;
      for (const group of groups) {
        const groupId = await this.store.upsertExactGroup(
          payload.rootId,
          payload.scanId,
          group,
          this.clock().toISOString(),
        );
        await this.store.createNeedsReview(duplicateReview(
          groupId,
          payload.rootId,
          payload.scanId,
          group.copyCount,
          group.byteLength,
          this.clock().toISOString(),
        ));
        checkpoint = {
          ...checkpoint,
          afterDigest: group.digestHex,
          afterByteLength: group.byteLength,
        };
        groupsProcessed += 1;
      }
      await context.saveCheckpoint(checkpointToJson(checkpoint));
      await context.reportProgress({
        phase: "exact-duplicate-groups",
        completedUnits: groupsProcessed,
        unit: "items",
        message: `Persisted ${groupsProcessed.toLocaleString()} verified duplicate groups.`,
        metrics: { exactGroupsProcessed: groupsProcessed, algorithm: "sha256" },
        updatedAt: this.clock().toISOString(),
      });
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "content-identity",
        status: "running",
        jobId,
        processed: checkpoint.processed,
        details: {
          algorithm: "sha256",
          phase: "exact-duplicate-groups",
          exactGroupsProcessed: groupsProcessed,
          reused: checkpoint.reused,
          failed: checkpoint.failed,
        },
        updatedAt: this.clock().toISOString(),
      });
    }
    return checkpoint;
  }

  private async hashOne(
    root: ApprovedLibraryRoot,
    task: HashTask,
    highWaterMark: number,
    onBytes: (bytes: number) => void,
  ): Promise<string> {
    const decision = await this.rootResolver.resolveExisting(root, task.relativePath);
    if (!decision.allowed) {
      throw new Error(`Source path is unavailable or unsafe: ${decision.reason}`);
    }
    const before = await lstat(decision.authorization.canonicalPath, { bigint: true });
    if (!matchesObservation(before, task)) {
      throw new Error("The source no longer matches the inventory observation.");
    }
    const digest = createHash("sha256");
    const stream = createReadStream(decision.authorization.canonicalPath, { highWaterMark });
    for await (const value of stream) {
      const chunk = value as Buffer;
      digest.update(chunk);
      onBytes(chunk.byteLength);
    }
    const after = await lstat(decision.authorization.canonicalPath, { bigint: true });
    if (!matchesObservation(after, task) || !sameFileState(before, after)) {
      throw new Error("The source changed while content identity was being computed.");
    }
    return digest.digest("hex");
  }

  private async recordHashFailure(task: HashTask, error: unknown): Promise<void> {
    const analyzedAt = this.clock().toISOString();
    const observationSignature = observationSignatureFor(task);
    await this.store.saveAnalyzerResult({
      recordId: task.recordId,
      rootId: task.rootId,
      scanId: task.scanId,
      analyzerId: "content-hash",
      analyzerVersion: "2.0.0",
      observationSignature,
      status: "failed",
      facts: { algorithm: "sha256" },
      warnings: [],
      error: { code: "HASH_SOURCE_CHANGED_OR_UNAVAILABLE", message: errorMessage(error) },
      analyzedAt,
    });
    await this.store.createNeedsReview({
      id: stableId("needs-review-v2", task.scanId, task.recordId, "stale-source"),
      rootId: task.rootId,
      scanId: task.scanId,
      recordId: task.recordId,
      reason: "stale-source",
      title: `Source changed: ${task.name}`,
      description: "The file disappeared, became unsafe, or changed after inventory. Scan again before relying on its identity.",
      evidence: { relativePath: task.relativePath, error: errorMessage(error) },
      status: "open",
      createdAt: analyzedAt,
    });
  }
}

function validateCandidatePayload(payload: JsonObject): void {
  exactKeys(payload, ["rootId", "scanId"]);
  requiredString(payload, "rootId");
  requiredString(payload, "scanId");
}

function validateHashPayload(payload: JsonObject): void {
  exactKeys(payload, ["rootId", "scanId", "rootIdentityKey", "scope"]);
  requiredString(payload, "rootId");
  requiredString(payload, "scanId");
  requiredString(payload, "rootIdentityKey");
  if (payload["scope"] !== "duplicate-candidates" && payload["scope"] !== "all") {
    throw new Error("content.hash scope must be duplicate-candidates or all.");
  }
}

function exactKeys(payload: JsonObject, expected: readonly string[]): void {
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Job payload must contain only: ${expected.join(", ")}.`);
  }
}

function requiredString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function candidateCheckpoint(value: JsonObject | undefined): {
  readonly initialized: boolean;
  readonly afterByteLength?: number;
  readonly processed: number;
} {
  if (value === undefined) return { initialized: false, processed: 0 };
  return {
    initialized: value["initialized"] === true,
    ...(typeof value["afterByteLength"] === "number"
      ? { afterByteLength: value["afterByteLength"] }
      : {}),
    processed: nonNegative(value["processed"]),
  };
}

function hashCheckpoint(value: JsonObject | undefined): HashCheckpoint {
  if (value === undefined) {
    return {
      phase: "hash",
      initialized: true,
      processed: 0,
      reused: 0,
      failed: 0,
      completedBytes: 0,
    };
  }
  const phase = value["phase"] === "exact-groups" ? "exact-groups" : "hash";
  return {
    phase,
    initialized: value["initialized"] !== false,
    ...(typeof value["afterRelativePath"] === "string"
      ? { afterRelativePath: value["afterRelativePath"] }
      : {}),
    ...(typeof value["afterRecordId"] === "string" ? { afterRecordId: value["afterRecordId"] } : {}),
    ...(typeof value["afterDigest"] === "string" ? { afterDigest: value["afterDigest"] } : {}),
    ...(typeof value["afterByteLength"] === "number"
      ? { afterByteLength: value["afterByteLength"] }
      : {}),
    processed: nonNegative(value["processed"]),
    reused: nonNegative(value["reused"]),
    failed: nonNegative(value["failed"]),
    completedBytes: nonNegative(value["completedBytes"]),
  };
}

function checkpointToJson(value: HashCheckpoint): JsonObject {
  return {
    phase: value.phase,
    initialized: value.initialized,
    ...(value.afterRelativePath === undefined ? {} : { afterRelativePath: value.afterRelativePath }),
    ...(value.afterRecordId === undefined ? {} : { afterRecordId: value.afterRecordId }),
    ...(value.afterDigest === undefined ? {} : { afterDigest: value.afterDigest }),
    ...(value.afterByteLength === undefined ? {} : { afterByteLength: value.afterByteLength }),
    processed: value.processed,
    reused: value.reused,
    failed: value.failed,
    completedBytes: value.completedBytes,
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function matchesObservation(stats: Awaited<ReturnType<typeof lstat>>, task: HashTask): boolean {
  if (!stats.isFile() || stats.isSymbolicLink()) return false;
  if (Number(stats.size) !== task.byteLength) return false;
  if (task.deviceId !== undefined && stats.dev.toString() !== task.deviceId) return false;
  if (task.filesystemRecordId !== undefined && stats.ino.toString() !== task.filesystemRecordId) return false;
  if (task.modifiedAt !== undefined && stats.mtime.toISOString() !== task.modifiedAt) return false;
  return true;
}

function sameFileState(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs;
}

function observationSignatureFor(task: HashTask): string {
  return createHash("sha256")
    .update(`${task.byteLength}\0${task.modifiedAt ?? ""}\0${task.deviceId ?? ""}\0${task.filesystemRecordId ?? ""}`)
    .digest("hex");
}

function duplicateReview(
  groupId: string,
  rootId: string,
  scanId: string,
  copies: number,
  byteLength: number,
  createdAt: string,
): NeedsReviewItem {
  return {
    id: stableId("needs-review-v2", scanId, groupId, "duplicate-keeper-uncertain"),
    rootId,
    scanId,
    groupId,
    reason: "duplicate-keeper-uncertain",
    title: `${copies} verified identical copies need a keeper decision`,
    description: "Choose the copy or copies to retain. Local Librarian will never delete the others automatically.",
    evidence: { copies, byteLength, reclaimableBytes: (copies - 1) * byteLength },
    status: "open",
    createdAt,
  };
}

function cooperativeStatus(error: unknown): "paused" | "cancelled" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "JobPauseRequested") return "paused";
  if (error.name === "JobCancellationRequested") return "cancelled";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(`${prefix}\0${parts.join("\0")}\0`, "utf8")
    .digest("hex");
  return `${prefix}:${digest}`;
}
