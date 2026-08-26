import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import * as path from "node:path";

import type { JsonObject } from "../domain/index.js";
import type {
  JobDefinition,
  JobExecutionContext,
  JobHandler,
  PersistentJobRecord,
  StructuredJobResult,
} from "../jobs/index.js";
import { JobHandlerFailure } from "../jobs/index.js";
import {
  defaultMetadataAnalyzers,
  type LocalMetadataAnalyzer,
  type HashTask,
  type SqliteIntelligenceStore,
} from "../intelligence/index.js";
import { categoryForExtension } from "../organization/index.js";
import type { TransferRootGuard } from "./root-guard.js";
import type { SqliteTransferStore } from "./transfer-store.js";
import type { DurableTransferItem, DurableTransferPlan } from "./types.js";

export const INGEST_ANALYSIS_JOB_DEFINITION: JobDefinition = {
  kind: "ingest.analyze",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validatePlanPayload,
};

interface Checkpoint {
  readonly phase: "discovery" | "analysis";
  readonly afterOrdinal: number;
  readonly discovered: number;
  readonly processed: number;
  readonly completedBytes: number;
}

export class IngestAnalysisJobHandler implements JobHandler {
  public readonly kind = "ingest.analyze" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #paths: path.PlatformPath;

  public constructor(
    private readonly guard: TransferRootGuard,
    private readonly transfers: SqliteTransferStore,
    private readonly intelligence: SqliteIntelligenceStore,
    private readonly analyzers: readonly LocalMetadataAnalyzer[] = defaultMetadataAnalyzers(),
    private readonly clock: () => Date = () => new Date(),
    platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix",
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    validatePlanPayload(job.payload);
    const planId = job.payload["planId"] as string;
    const plan = await this.transfers.plan(planId);
    if (plan === undefined || plan.kind !== "ingest") {
      throw new JobHandlerFailure("INGEST_PLAN_NOT_FOUND", "The ingest plan does not exist.", false);
    }
    if (plan.analysisJobId !== undefined && plan.analysisJobId !== job.id) {
      throw new JobHandlerFailure("INGEST_JOB_BINDING_MISMATCH", "The ingest plan belongs to another job.", false);
    }
    if (["ready-for-approval", "needs-review", "completed"].includes(plan.status)) {
      return this.result(plan, job.id);
    }
    let checkpoint = checkpointFrom(context.checkpoint);
    try {
      await this.transfers.setPlanState(plan.id, "analyzing", this.now());
      const source = await this.guard.validate(plan.sourceRootId, plan.sourceRootIdentityKey, {
        role: "ingest-source",
      });
      if (checkpoint.phase === "discovery") {
        checkpoint = await this.discover(plan, source, context, checkpoint);
      }
      checkpoint = await this.analyze(plan, source, context, checkpoint);
      const current = await this.transfers.plan(plan.id);
      if (current === undefined) throw new Error("The ingest plan disappeared.");
      const terminal = current.counts.needsReview > 0 || current.counts.failed > 0
        ? "needs-review"
        : "ready-for-approval";
      const completed = await this.transfers.setPlanState(plan.id, terminal, this.now());
      return this.result(completed, job.id);
    } catch (error) {
      if (isCooperativeControl(error)) throw error;
      await this.transfers.setPlanState(plan.id, "failed", this.now(), {
        error: { code: "INGEST_ANALYSIS_FAILED", message: errorMessage(error) },
      });
      if (error instanceof JobHandlerFailure) throw error;
      throw new JobHandlerFailure("INGEST_ANALYSIS_FAILED", errorMessage(error), true, { planId });
    }
  }

  private async discover(
    plan: DurableTransferPlan,
    source: Awaited<ReturnType<TransferRootGuard["validate"]>>,
    context: JobExecutionContext,
    initial: Checkpoint,
  ): Promise<Checkpoint> {
    let checkpoint = initial;
    await this.transfers.addDirectory(plan.id, "");
    await this.transfers.resetScanningDirectories(plan.id);
    for (;;) {
      await context.throwIfControlRequested();
      await this.guard.validate(plan.sourceRootId, plan.sourceRootIdentityKey, { role: "ingest-source" });
      const relativeDirectory = await this.transfers.claimDirectory(plan.id);
      if (relativeDirectory === undefined) break;
      const directoryPath = relativeDirectory.length === 0
        ? source.canonicalPath
        : (await this.guard.resolveExisting(source, relativeDirectory)).canonicalPath;
      const handle = await opendir(directoryPath, { bufferSize: 64 });
      const batch: Array<Omit<DurableTransferItem,
        "planId" | "ordinal" | "metadata" | "duplicateMatches" | "status" | "copiedBytes" | "updatedAt">> = [];
      try {
        for await (const entry of handle) {
          if (entry.name === ".local-librarian") continue;
          const relativePath = joinPortable(relativeDirectory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            await this.transfers.addDirectory(plan.id, relativePath);
            continue;
          }
          if (!entry.isFile()) continue;
          const absolute = this.#paths.join(directoryPath, entry.name);
          let stats;
          try {
            stats = await lstat(absolute, { bigint: true });
          } catch {
            continue;
          }
          if (!stats.isFile() || stats.isSymbolicLink() || stats.dev.toString() !== source.identity.volume.deviceId) {
            continue;
          }
          batch.push({
            id: stableItemId(plan.id, relativePath),
            sourceRelativePath: relativePath,
            originalSourcePath: this.#paths.join(plan.sourceDisplayPath, relativePath),
            originalFileName: entry.name,
            byteLength: safeNumber(stats.size),
            sourceModifiedAt: stats.mtime.toISOString(),
            sourceDeviceId: stats.dev.toString(),
            sourceFilesystemRecordId: stats.ino.toString(),
          });
          if (batch.length >= 256) {
            await this.transfers.addDiscoveredItems(plan.id, batch.splice(0), this.now());
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (batch.length > 0) await this.transfers.addDiscoveredItems(plan.id, batch, this.now());
      await this.transfers.completeDirectory(plan.id, relativeDirectory);
      const current = await this.transfers.plan(plan.id);
      checkpoint = {
        ...checkpoint,
        discovered: current?.counts.total ?? checkpoint.discovered,
      };
      await context.saveCheckpoint(checkpointToJson(checkpoint));
      await context.reportProgress({
        phase: "ingest-inventory",
        completedUnits: checkpoint.discovered,
        unit: "items",
        message: `Discovered ${checkpoint.discovered.toLocaleString()} source files.`,
        metrics: { currentDirectory: relativeDirectory, metadataOnly: true },
        updatedAt: this.now(),
      });
    }
    checkpoint = { ...checkpoint, phase: "analysis", afterOrdinal: -1 };
    await context.saveCheckpoint(checkpointToJson(checkpoint));
    return checkpoint;
  }

  private async analyze(
    plan: DurableTransferPlan,
    source: Awaited<ReturnType<TransferRootGuard["validate"]>>,
    context: JobExecutionContext,
    initial: Checkpoint,
  ): Promise<Checkpoint> {
    let checkpoint = initial;
    for (;;) {
      await context.throwIfControlRequested();
      await this.guard.validate(plan.sourceRootId, plan.sourceRootIdentityKey, { role: "ingest-source" });
      const items = await this.transfers.workItems(plan.id, ["discovered"], checkpoint.afterOrdinal, 25);
      if (items.length === 0) break;
      for (const item of items) {
        await context.throwIfControlRequested();
        try {
          const authorization = await this.guard.resolveExisting(source, item.sourceRelativePath);
          const digest = await hashStableFile(authorization.canonicalPath, item);
          const matches = await this.intelligence.exactContentMatches(digest, item.byteLength, 500);
          const analyzed = await this.analyzeMetadata(item, authorization.canonicalPath);
          if (matches.length > 0) {
            await this.transfers.setItemState(item.id, "exact-duplicate", this.now(), {
              algorithm: "sha256",
              digestHex: digest,
              category: analyzed.category,
              ...(analyzed.mimeType === undefined ? {} : { mimeType: analyzed.mimeType }),
              confidence: analyzed.confidence,
              explanation: "Verified content identity already exists in an enrolled library.",
              metadata: analyzed.metadata,
              duplicateMatches: matches,
            });
          } else {
            const destination = proposedDestination(plan, item, analyzed.category);
            const status = analyzed.confidence < 0.65 ? "needs-review" : "ready";
            await this.transfers.setItemState(item.id, status, this.now(), {
              algorithm: "sha256",
              digestHex: digest,
              destinationRelativePath: destination,
              category: analyzed.category,
              ...(analyzed.mimeType === undefined ? {} : { mimeType: analyzed.mimeType }),
              confidence: analyzed.confidence,
              explanation: analyzed.explanation,
              metadata: analyzed.metadata,
            });
          }
          checkpoint = {
            ...checkpoint,
            afterOrdinal: item.ordinal,
            processed: checkpoint.processed + 1,
            completedBytes: checkpoint.completedBytes + item.byteLength,
          };
        } catch (error) {
          await this.transfers.setItemState(item.id, "needs-review", this.now(), {
            error: {
              code: "INGEST_SOURCE_CHANGED_OR_UNAVAILABLE",
              message: errorMessage(error),
              retryable: false,
            },
          });
          checkpoint = { ...checkpoint, afterOrdinal: item.ordinal, processed: checkpoint.processed + 1 };
        }
      }
      await context.saveCheckpoint(checkpointToJson(checkpoint));
      const current = await this.transfers.plan(plan.id);
      const totalBytes = current?.counts.totalBytes;
      await context.reportProgress({
        phase: "ingest-content-analysis",
        completedUnits: checkpoint.completedBytes,
        ...(totalBytes === undefined ? {} : { totalUnits: totalBytes }),
        unit: "bytes",
        percent: (current?.counts.totalBytes ?? 0) === 0
          ? 100
          : Math.min(99, Math.floor((checkpoint.completedBytes / current!.counts.totalBytes) * 100)),
        message: `Understood ${checkpoint.processed.toLocaleString()} of ${(current?.counts.total ?? 0).toLocaleString()} source files.`,
        metrics: {
          filesProcessed: checkpoint.processed,
          exactDuplicates: current?.counts.exactDuplicates ?? 0,
          needsReview: current?.counts.needsReview ?? 0,
          algorithm: "sha256",
        },
        updatedAt: this.now(),
      });
    }
    return checkpoint;
  }

  private async analyzeMetadata(item: DurableTransferItem, absolutePath: string): Promise<{
    readonly category: string;
    readonly mimeType?: string;
    readonly confidence: number;
    readonly explanation: string;
    readonly metadata: JsonObject;
  }> {
    const extension = extensionOf(item.originalFileName);
    const task: HashTask = {
      recordId: item.id,
      rootId: item.planId,
      scanId: item.planId,
      relativePath: item.sourceRelativePath,
      name: item.originalFileName,
      ...(extension === undefined ? {} : { extension }),
      byteLength: item.byteLength,
      ...(item.sourceModifiedAt === undefined ? {} : { modifiedAt: item.sourceModifiedAt }),
      ...(item.sourceDeviceId === undefined ? {} : { deviceId: item.sourceDeviceId }),
      ...(item.sourceFilesystemRecordId === undefined
        ? {}
        : { filesystemRecordId: item.sourceFilesystemRecordId }),
    };
    const metadata: Record<string, JsonObject> = {};
    const warnings: string[] = [];
    let failures = 0;
    for (const analyzer of this.analyzers) {
      if (!analyzer.supports(task)) continue;
      try {
        const outcome = await analyzer.analyze(task, absolutePath);
        metadata[analyzer.id] = outcome.facts;
        warnings.push(...outcome.warnings);
      } catch (error) {
        failures += 1;
        warnings.push(`${analyzer.id}: ${errorMessage(error)}`);
      }
    }
    const basic = metadata["basic-type"];
    const mimeType = typeof basic?.["mimeType"] === "string" ? basic["mimeType"] : undefined;
    let category = categoryForExtension(extension);
    if (category === "Other") category = categoryForMime(mimeType) ?? category;
    const confidence = category === "Other" ? 0.35 : failures > 0 ? 0.75 : 0.9;
    return {
      category,
      ...(mimeType === undefined ? {} : { mimeType }),
      confidence,
      explanation: category === "Other"
        ? "Local type evidence is not sufficient to choose a reliable destination."
        : `Local extension and type evidence classify this source as ${category}.`,
      metadata: { analyzers: metadata, warnings },
    };
  }

  private result(plan: DurableTransferPlan, jobId: string): StructuredJobResult {
    return {
      summary: {
        planId: plan.id,
        discovered: plan.counts.total,
        ready: plan.counts.ready,
        exactDuplicates: plan.counts.exactDuplicates,
        needsReview: plan.counts.needsReview,
      },
      artifacts: [{ kind: "other", id: plan.id, mediaType: "application/vnd.local-librarian.ingest-plan+json" }],
      completedAt: this.now(),
    };
  }

  private now(): string { return this.clock().toISOString(); }
}

async function hashStableFile(absolutePath: string, item: DurableTransferItem): Promise<string> {
  const before = await lstat(absolutePath, { bigint: true });
  if (!matches(before, item)) throw new Error("The source changed after ingest discovery.");
  const hash = createHash("sha256");
  const stream = createReadStream(absolutePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const after = await lstat(absolutePath, { bigint: true });
  if (!matches(after, item) || !sameState(before, after)) {
    throw new Error("The source changed while its content identity was computed.");
  }
  return hash.digest("hex");
}

function matches(stats: BigIntStats, item: DurableTransferItem): boolean {
  return stats.isFile() && !stats.isSymbolicLink() &&
    safeNumber(stats.size) === item.byteLength &&
    (item.sourceModifiedAt === undefined || stats.mtime.toISOString() === item.sourceModifiedAt) &&
    (item.sourceDeviceId === undefined || stats.dev.toString() === item.sourceDeviceId) &&
    (item.sourceFilesystemRecordId === undefined || stats.ino.toString() === item.sourceFilesystemRecordId);
}

function sameState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function proposedDestination(plan: DurableTransferPlan, item: DurableTransferItem, category: string): string {
  const target = plan.targetDirectory ?? "Imported";
  return plan.preserveSourceFolders && item.sourceRelativePath.includes("/")
    ? `${target}/${item.sourceRelativePath}`
    : `${target}/${category}/${item.originalFileName}`;
}

function categoryForMime(mimeType: string | undefined): string | undefined {
  if (mimeType?.startsWith("image/")) return "Images";
  if (mimeType?.startsWith("video/")) return "Videos";
  if (mimeType?.startsWith("audio/")) return "Audio";
  if (mimeType?.startsWith("text/") || mimeType === "application/pdf") return "Documents";
  if (mimeType?.includes("zip") || mimeType?.includes("compressed")) return "Archives";
  return undefined;
}

function extensionOf(name: string): string | undefined {
  const index = name.lastIndexOf(".");
  return index <= 0 || index === name.length - 1
    ? undefined
    : name.slice(index + 1).toLocaleLowerCase("en-US");
}

function joinPortable(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

function stableItemId(planId: string, relativePath: string): string {
  return `transfer-item-v2:${createHash("sha256").update(planId).update("\0").update(relativePath).digest("hex")}`;
}

function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("File size exceeds SQLite's safe numeric range.");
  return number;
}

function checkpointFrom(value: JsonObject | undefined): Checkpoint {
  return {
    phase: value?.["phase"] === "analysis" ? "analysis" : "discovery",
    afterOrdinal: nonNegative(value?.["afterOrdinal"], -1),
    discovered: nonNegative(value?.["discovered"]),
    processed: nonNegative(value?.["processed"]),
    completedBytes: nonNegative(value?.["completedBytes"]),
  };
}

function checkpointToJson(value: Checkpoint): JsonObject {
  return { ...value };
}

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= fallback ? value : fallback;
}

function validatePlanPayload(payload: JsonObject): void {
  if (
    Object.keys(payload).length !== 1 ||
    typeof payload["planId"] !== "string" || payload["planId"].trim().length === 0
  ) {
    throw new Error("ingest.analyze payload must contain only a non-empty planId.");
  }
}

function isCooperativeControl(error: unknown): boolean {
  return error instanceof Error && ["JobPauseRequested", "JobCancellationRequested"].includes(error.name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ingest analysis failed.";
}
