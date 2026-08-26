import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";

import type { JsonObject } from "../domain/index.js";
import type { ApprovedEnrolledRoot, RootEnrollmentStore } from "../enrollment/index.js";
import type {
  JobClient,
  JobDefinition,
  JobExecutionContext,
  JobHandler,
  PersistentJobRecord,
  StructuredJobResult,
} from "../jobs/index.js";
import { JobHandlerFailure } from "../jobs/index.js";
import type { SqliteIntelligenceStore } from "../intelligence/index.js";
import type { SqliteOrganizationStore } from "../organization/index.js";
import type { TransferRootGuard } from "./root-guard.js";
import { TransferRootValidationError } from "./root-guard.js";
import type { SqliteTransferStore } from "./transfer-store.js";
import type {
  DurableTransferItem,
  DurableTransferPlan,
  QuarantineItem,
  TransferReceipt,
} from "./types.js";

export const INGEST_TRANSFER_JOB_DEFINITION: JobDefinition = {
  kind: "ingest.transfer",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validatePlanPayload,
};

export const CROSS_VOLUME_TRANSFER_JOB_DEFINITION: JobDefinition = {
  kind: "transfer.execute",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validatePlanPayload,
};

export const QUARANTINE_EXECUTE_JOB_DEFINITION: JobDefinition = {
  kind: "quarantine.execute",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validatePlanPayload,
};

export const QUARANTINE_RESTORE_JOB_DEFINITION: JobDefinition = {
  kind: "quarantine.restore",
  recoveryMode: "resume-from-checkpoint",
  validatePayload(payload): void {
    validateSingleStringPayload(payload, "quarantineId");
  },
};

export type TransferCapacityProbe = (canonicalRootPath: string) => Promise<bigint>;

class TransferExecutionEngine {
  readonly #paths: path.PlatformPath;

  public constructor(
    private readonly guard: TransferRootGuard,
    private readonly transfers: SqliteTransferStore,
    private readonly organization: SqliteOrganizationStore,
    private readonly enrollments: RootEnrollmentStore,
    private readonly intelligence: SqliteIntelligenceStore,
    private readonly jobs?: JobClient,
    private readonly clock: () => Date = () => new Date(),
    platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix",
    private readonly capacityProbe: TransferCapacityProbe = availableCapacity,
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
    expectedKind: DurableTransferPlan["kind"],
  ): Promise<StructuredJobResult> {
    validatePlanPayload(job.payload);
    const planId = job.payload["planId"] as string;
    let plan = await this.transfers.plan(planId);
    if (plan === undefined || plan.kind !== expectedKind) {
      throw new JobHandlerFailure("TRANSFER_PLAN_NOT_FOUND", "The transfer plan does not exist or has the wrong kind.", false);
    }
    if (plan.transferJobId !== undefined && plan.transferJobId !== job.id) {
      throw new JobHandlerFailure("TRANSFER_JOB_BINDING_MISMATCH", "The transfer plan belongs to a different job.", false);
    }
    if (["completed", "partial"].includes(plan.status)) return resultFor(plan, job.id, this.now());
    if (!["approved", "transfer-queued", "transferring"].includes(plan.status)) {
      throw new JobHandlerFailure("TRANSFER_PLAN_NOT_APPROVED", "The transfer plan is not approved for execution.", false);
    }
    const afterOrdinal = checkpointOrdinal(context.checkpoint);
    try {
      await this.validateGates(plan);
      plan = await this.transfers.setPlanState(plan.id, "transferring", this.now());
      let cursor = afterOrdinal;
      for (;;) {
        await context.throwIfControlRequested();
        const items = await this.transfers.workItems(
          plan.id,
          ["ready", "copying", "verified"],
          cursor,
          25,
        );
        if (items.length === 0) break;
        for (const item of items) {
          await context.throwIfControlRequested();
          await this.validateGates(plan);
          try {
            if (plan.kind === "duplicate-consolidation") {
              await this.quarantineSource(plan, item, job.id);
            } else {
              await this.transferOne(plan, item, job.id, context);
            }
          } catch (error) {
            if (isCooperativeControl(error) || error instanceof MutationGateChangedError) throw error;
            await this.transfers.setItemState(item.id, "failed", this.now(), {
              error: classifyItemError(error),
            });
          }
          cursor = item.ordinal;
          await context.saveCheckpoint({ planId: plan.id, lastCompletedOrdinal: cursor });
          const current = await this.transfers.plan(plan.id);
          if (current === undefined) throw new Error("The transfer plan disappeared.");
          await context.reportProgress({
            phase: plan.kind === "duplicate-consolidation" ? "quarantine" : "verified-transfer",
            completedUnits: current.counts.copiedBytes,
            totalUnits: current.counts.totalBytes,
            unit: plan.kind === "duplicate-consolidation" ? "items" : "bytes",
            percent: current.counts.totalBytes === 0
              ? 100
              : Math.min(99, Math.floor((current.counts.copiedBytes / current.counts.totalBytes) * 100)),
            message: `Processed ${item.sourceRelativePath}`,
            metrics: {
              completed: current.counts.completed,
              quarantined: current.counts.quarantined,
              failed: current.counts.failed,
            },
            updatedAt: this.now(),
          });
        }
      }
      plan = await this.transfers.plan(plan.id) ?? plan;
      const terminal = plan.counts.failed > 0 ? "partial" : "completed";
      plan = await this.transfers.setPlanState(plan.id, terminal, this.now());
      const receipt: TransferReceipt = {
        formatVersion: 2,
        id: `transfer-receipt-v2:${createHash("sha256").update(plan.id).update("\0").update(job.id).digest("hex")}`,
        planId: plan.id,
        jobId: job.id,
        kind: plan.kind,
        status: terminal,
        counts: plan.counts,
        completedAt: this.now(),
      };
      await this.transfers.saveReceipt(receipt);
      await this.submitCatalogRefresh(plan, job);
      return resultFor(plan, job.id, this.now(), receipt.id);
    } catch (error) {
      if (isCooperativeControl(error)) {
        await this.transfers.setPlanState(
          plan.id,
          error instanceof Error && error.name === "JobCancellationRequested" ? "cancelled" : "transfer-queued",
          this.now(),
        );
        throw error;
      }
      const code = executionErrorCode(error);
      await this.transfers.setPlanState(plan.id, "failed", this.now(), {
        error: {
          code,
          message: errorMessage(error),
        },
      });
      if (error instanceof JobHandlerFailure) throw error;
      throw new JobHandlerFailure(
        code,
        errorMessage(error),
        false,
        { planId: plan.id, sourcePreserved: true },
      );
    }
  }

  private async transferOne(
    plan: DurableTransferPlan,
    item: DurableTransferItem,
    jobId: string,
    context: JobExecutionContext,
  ): Promise<void> {
    if (item.digestHex === undefined || item.algorithm !== "sha256" || item.destinationRelativePath === undefined) {
      throw new Error("Transfer item lacks verified identity or destination evidence.");
    }
    const destinationRelativePath = item.destinationRelativePath;
    const roots = await this.validateGates(plan);
    if (roots.destination === undefined) throw new Error("The transfer plan has no destination library.");
    let current = item;
    if (current.status !== "verified") {
      const existing = await this.safeExisting(roots.destination, destinationRelativePath);
      if (existing !== undefined) {
        const stats = await lstat(existing, { bigint: true });
        if (safeNumber(stats.size) !== current.byteLength || await sha256(existing) !== current.digestHex) {
          throw new DestinationCollisionError();
        }
        current = await this.transfers.setItemState(current.id, "verified", this.now(), {
          copiedBytes: current.byteLength,
          destinationVerifiedAt: this.now(),
        });
      } else {
        current = await this.copyVerifyCommit(plan, current, roots.source, roots.destination, context);
      }
    }
    if (plan.retireSource) {
      await this.validateGates(plan);
      await this.quarantineSource(plan, current, jobId);
    } else {
      await this.transfers.setItemState(current.id, "completed", this.now(), {
        copiedBytes: current.byteLength,
        destinationVerifiedAt: current.destinationVerifiedAt ?? this.now(),
      });
    }
  }

  private async copyVerifyCommit(
    plan: DurableTransferPlan,
    item: DurableTransferItem,
    sourceRoot: ApprovedEnrolledRoot,
    destinationRoot: ApprovedEnrolledRoot,
    context: JobExecutionContext,
  ): Promise<DurableTransferItem> {
    const sourcePath = await this.safeExisting(sourceRoot, item.sourceRelativePath);
    if (sourcePath === undefined) {
      throw new StaleSourceError("The source disappeared before transfer; no destination was committed.");
    }
    const sourceBefore = await lstat(sourcePath, { bigint: true });
    if (!matchesSource(sourceBefore, item)) throw new StaleSourceError();
    const stagingRelativePath = stagingPath(plan.id, item.id);
    const stagingParent = portableDirname(stagingRelativePath);
    await this.guard.authorizeProspectiveWrite(destinationRoot, stagingParent);
    await mkdir(this.#paths.join(destinationRoot.canonicalPath, stagingParent), { recursive: true });
    const stagingAbsolute = this.#paths.join(destinationRoot.canonicalPath, ...stagingRelativePath.split("/"));
    const existingStaging = await lstat(stagingAbsolute, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (existingStaging === undefined) {
      await this.guard.authorizeProspectiveWrite(destinationRoot, stagingRelativePath);
    } else {
      await this.guard.authorizeExistingWrite(destinationRoot, stagingRelativePath);
      if (!existingStaging.isFile() || existingStaging.isSymbolicLink()) {
        throw new TransferRootValidationError(
          "ROOT_BOUNDARY_DENIED",
          "The resumable transfer staging path is not a regular file.",
        );
      }
    }
    const availableBytes = await this.capacityProbe(destinationRoot.canonicalPath);
    const remaining = BigInt(item.byteLength) - (existingStaging?.size ?? 0n);
    if (availableBytes < remaining + 16n * 1024n * 1024n) {
      throw new InsufficientSpaceError();
    }
    await this.transfers.setItemState(item.id, "copying", this.now(), {
      copiedBytes: existingStaging === undefined ? 0 : safeNumber(existingStaging.size),
    });
    await this.copyResumable(
      sourcePath,
      stagingAbsolute,
      item,
      plan,
      context,
    );
    const sourceAfter = await lstat(sourcePath, { bigint: true });
    if (!matchesSource(sourceAfter, item) || !sameState(sourceBefore, sourceAfter)) {
      throw new StaleSourceError("The source changed during transfer; the original remains untouched.");
    }
    const [sourceDigest, stagingDigest] = await Promise.all([
      sha256(sourcePath),
      sha256(stagingAbsolute),
    ]);
    if (sourceDigest !== item.digestHex) {
      throw new StaleSourceError("The source no longer matches its approved content identity.");
    }
    if (stagingDigest !== sourceDigest) {
      const handle = await open(stagingAbsolute, "r+");
      try { await handle.truncate(0); await handle.sync(); } finally { await handle.close(); }
      await this.copyResumable(sourcePath, stagingAbsolute, item, plan, context);
      if (await sha256(stagingAbsolute) !== sourceDigest) {
        throw new Error("Destination staging verification failed after a clean retry.");
      }
    }
    await this.validateGates(plan);
    const destinationParent = portableDirname(item.destinationRelativePath!);
    await this.guard.authorizeProspectiveWrite(destinationRoot, destinationParent);
    await mkdir(this.#paths.join(destinationRoot.canonicalPath, ...destinationParent.split("/")), { recursive: true });
    const destinationAuthorization = await this.guard.authorizeProspectiveWrite(
      destinationRoot,
      item.destinationRelativePath!,
    );
    try {
      await link(stagingAbsolute, destinationAuthorization.canonicalPath);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) throw new DestinationCollisionError();
      if (!isNodeErrorOneOf(error, ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV"])) throw error;
      const finalCopyCapacity = await this.capacityProbe(destinationRoot.canonicalPath);
      if (finalCopyCapacity < BigInt(item.byteLength) + 16n * 1024n * 1024n) {
        throw new InsufficientSpaceError("This filesystem requires a collision-safe final copy and lacks space for it.");
      }
      await copyFile(stagingAbsolute, destinationAuthorization.canonicalPath, constants.COPYFILE_EXCL);
      const handle = await open(destinationAuthorization.canonicalPath, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const verifiedAuthorization = await this.guard.resolveExisting(destinationRoot, item.destinationRelativePath!);
    const destinationStats = await lstat(verifiedAuthorization.canonicalPath, { bigint: true });
    if (safeNumber(destinationStats.size) !== item.byteLength || await sha256(verifiedAuthorization.canonicalPath) !== sourceDigest) {
      throw new Error("The committed destination did not pass content-identity verification.");
    }
    await unlink(stagingAbsolute).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    return this.transfers.setItemState(item.id, "verified", this.now(), {
      copiedBytes: item.byteLength,
      destinationVerifiedAt: this.now(),
    });
  }

  private async copyResumable(
    sourcePath: string,
    stagingPathValue: string,
    item: DurableTransferItem,
    plan: DurableTransferPlan,
    context: JobExecutionContext,
  ): Promise<void> {
    const settings = await this.intelligence.settings();
    const chunkBytes = settings.throughputMode === "maximum"
      ? 8 * 1024 * 1024
      : settings.throughputMode === "balanced" ? 4 * 1024 * 1024 : 1024 * 1024;
    const source = await open(sourcePath, "r");
    let destination: FileHandle | undefined;
    try {
      destination = await open(stagingPathValue, "r+").catch(async (error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
        return open(stagingPathValue, "wx+");
      });
      const stageStats = await destination.stat({ bigint: true });
      let offset = stageStats.size > BigInt(item.byteLength) ? 0 : safeNumber(stageStats.size);
      if (offset === 0 && stageStats.size > 0n) await destination.truncate(0);
      const buffer = Buffer.allocUnsafe(chunkBytes);
      let lastReport = Date.now();
      while (offset < item.byteLength) {
        await context.throwIfControlRequested();
        await this.validateGates(plan);
        const length = Math.min(buffer.byteLength, item.byteLength - offset);
        const read = await source.read(buffer, 0, length, offset);
        if (read.bytesRead === 0) throw new StaleSourceError("The source disappeared or became shorter during transfer.");
        let written = 0;
        while (written < read.bytesRead) {
          const result = await destination.write(buffer, written, read.bytesRead - written, offset + written);
          written += result.bytesWritten;
        }
        offset += read.bytesRead;
        if (Date.now() - lastReport >= 5_000 || offset === item.byteLength) {
          await destination.sync();
          await this.transfers.setItemState(item.id, "copying", this.now(), { copiedBytes: offset });
          await context.saveCheckpoint({ planId: plan.id, currentItemId: item.id, currentItemBytes: offset });
          await context.reportProgress({
            phase: "copying",
            completedUnits: offset,
            totalUnits: item.byteLength,
            unit: "bytes",
            percent: item.byteLength === 0 ? 100 : Math.floor((offset / item.byteLength) * 100),
            message: `Copying ${item.sourceRelativePath}`,
            metrics: { itemId: item.id, resumable: true, throughputMode: settings.throughputMode },
            updatedAt: this.now(),
          });
          lastReport = Date.now();
        }
      }
      await destination.truncate(item.byteLength);
      await destination.sync();
    } finally {
      await destination?.close().catch(() => undefined);
      await source.close().catch(() => undefined);
    }
  }

  private async quarantineSource(
    plan: DurableTransferPlan,
    item: DurableTransferItem,
    jobId: string,
  ): Promise<QuarantineItem> {
    const existingRecord = await this.transfers.quarantineForTransferItem(item.id);
    if (existingRecord !== undefined) return existingRecord;
    if (item.digestHex === undefined || item.algorithm !== "sha256") {
      throw new Error("A verified content identity is required before quarantine.");
    }
    const roots = await this.validateGates(plan);
    const quarantineId = deterministicQuarantineId(plan.id, item.id);
    const quarantineRelative = quarantinePath(quarantineId, item.originalFileName);
    const sourceExisting = await this.safeExisting(roots.source, item.sourceRelativePath);
    if (sourceExisting === undefined) {
      const recovered = await this.safeExisting(roots.source, quarantineRelative);
      if (
        recovered === undefined ||
        safeNumber((await lstat(recovered, { bigint: true })).size) !== item.byteLength ||
        await sha256(recovered) !== item.digestHex
      ) {
        throw new StaleSourceError("The source disappeared before quarantine and no verified recovery copy exists.");
      }
      return this.recordQuarantine(plan, item, jobId, quarantineId, quarantineRelative);
    }
    const stats = await lstat(sourceExisting, { bigint: true });
    if (!matchesSource(stats, item) || await sha256(sourceExisting) !== item.digestHex) {
      throw new StaleSourceError("The source changed before quarantine; it was preserved.");
    }
    const parent = portableDirname(quarantineRelative);
    await this.guard.authorizeProspectiveWrite(roots.source, parent);
    await mkdir(this.#paths.join(roots.source.canonicalPath, ...parent.split("/")), { recursive: true });
    const destination = await this.guard.authorizeProspectiveWrite(roots.source, quarantineRelative);
    await this.validateGates(plan);
    await rename(sourceExisting, destination.canonicalPath);
    const verified = await this.guard.resolveExisting(roots.source, quarantineRelative);
    const after = await lstat(verified.canonicalPath, { bigint: true });
    if (safeNumber(after.size) !== item.byteLength || await sha256(verified.canonicalPath) !== item.digestHex) {
      throw new JobHandlerFailure(
        "POST_QUARANTINE_VERIFICATION_INDETERMINATE",
        "The source was relocated but post-quarantine verification was interrupted. Retry recovery before taking another action.",
        true,
        { planId: plan.id, itemId: item.id, sourcePreservedInQuarantine: true },
      );
    }
    return this.recordQuarantine(plan, item, jobId, quarantineId, quarantineRelative);
  }

  private recordQuarantine(
    plan: DurableTransferPlan,
    item: DurableTransferItem,
    jobId: string,
    quarantineId: string,
    quarantineRelative: string,
  ): Promise<QuarantineItem> {
    return this.transfers.createQuarantine({
      id: quarantineId,
      rootId: plan.sourceRootId,
      rootIdentityKey: plan.sourceRootIdentityKey,
      originalRelativePath: item.sourceRelativePath,
      quarantinedRelativePath: quarantineRelative,
      originalFileName: item.originalFileName,
      algorithm: "sha256",
      digestHex: item.digestHex!,
      byteLength: item.byteLength,
      reason: plan.kind === "duplicate-consolidation"
        ? "duplicate-consolidation"
        : "verified-source-retirement",
      planId: plan.id,
      transferItemId: item.id,
      jobId,
      status: "active",
      quarantinedAt: this.now(),
    });
  }

  private async validateGates(plan: DurableTransferPlan): Promise<{
    readonly source: ApprovedEnrolledRoot;
    readonly destination?: ApprovedEnrolledRoot;
  }> {
    const mode = await this.organization.mutationMode();
    if (mode.mode !== "live") throw new MutationGateChangedError("Global mutation mode changed to READ ONLY.");
    const sourceRole = plan.kind === "ingest" ? "ingest-source" : "library";
    const source = await this.guard.validate(plan.sourceRootId, plan.sourceRootIdentityKey, {
      role: sourceRole,
      requireWrite: plan.retireSource,
      requireSourceRetirement: plan.kind === "ingest" && plan.retireSource,
    });
    if (plan.destinationRootId === undefined || plan.destinationRootIdentityKey === undefined) {
      return { source };
    }
    const destination = await this.guard.validate(
      plan.destinationRootId,
      plan.destinationRootIdentityKey,
      { role: "library", requireWrite: true },
    );
    return { source, destination };
  }

  private async safeExisting(root: ApprovedEnrolledRoot, relativePath: string): Promise<string | undefined> {
    try {
      return (await this.guard.resolveExisting(root, relativePath)).canonicalPath;
    } catch (error) {
      const lexical = this.#paths.join(root.canonicalPath, ...relativePath.split("/"));
      try {
        await lstat(lexical);
      } catch (statError) {
        if (isNodeError(statError, "ENOENT")) return undefined;
      }
      throw error;
    }
  }

  private async submitCatalogRefresh(plan: DurableTransferPlan, job: PersistentJobRecord): Promise<void> {
    if (this.jobs === undefined || plan.destinationRootId === undefined || plan.destinationRootIdentityKey === undefined) {
      return;
    }
    await this.jobs.submit({
      kind: "inventory.scan",
      payload: { rootId: plan.destinationRootId, rootIdentityKey: plan.destinationRootIdentityKey },
      priority: 15,
      idempotencyKey: `post-transfer-inventory:${plan.id}`,
      requestedBy: job.requestedBy,
      controlPolicy: {
        pauseMode: "checkpoint",
        cancellationMode: "cooperative",
        maximumAttempts: 3,
        leaseDurationMilliseconds: 30_000,
      },
    });
  }

  private now(): string { return this.clock().toISOString(); }
}

export class IngestTransferJobHandler implements JobHandler {
  public readonly kind = "ingest.transfer" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #engine: TransferExecutionEngine;
  public constructor(...args: ConstructorParameters<typeof TransferExecutionEngine>) {
    this.#engine = new TransferExecutionEngine(...args);
  }
  public run(job: PersistentJobRecord, context: JobExecutionContext) {
    return this.#engine.run(job, context, "ingest");
  }
}

export class CrossVolumeTransferJobHandler implements JobHandler {
  public readonly kind = "transfer.execute" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #engine: TransferExecutionEngine;
  public constructor(...args: ConstructorParameters<typeof TransferExecutionEngine>) {
    this.#engine = new TransferExecutionEngine(...args);
  }
  public run(job: PersistentJobRecord, context: JobExecutionContext) {
    return this.#engine.run(job, context, "cross-volume-organization");
  }
}

export class QuarantineExecutionJobHandler implements JobHandler {
  public readonly kind = "quarantine.execute" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #engine: TransferExecutionEngine;
  public constructor(...args: ConstructorParameters<typeof TransferExecutionEngine>) {
    this.#engine = new TransferExecutionEngine(...args);
  }
  public run(job: PersistentJobRecord, context: JobExecutionContext) {
    return this.#engine.run(job, context, "duplicate-consolidation");
  }
}

export class QuarantineRestoreJobHandler implements JobHandler {
  public readonly kind = "quarantine.restore" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #paths: path.PlatformPath;

  public constructor(
    private readonly guard: TransferRootGuard,
    private readonly transfers: SqliteTransferStore,
    private readonly organization: SqliteOrganizationStore,
    private readonly enrollments: RootEnrollmentStore,
    private readonly clock: () => Date = () => new Date(),
    platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix",
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  public async run(job: PersistentJobRecord, _context: JobExecutionContext): Promise<StructuredJobResult> {
    QUARANTINE_RESTORE_JOB_DEFINITION.validatePayload(job.payload);
    const id = job.payload["quarantineId"] as string;
    const item = await this.transfers.quarantineItem(id);
    if (item === undefined) throw new JobHandlerFailure("QUARANTINE_NOT_FOUND", "The quarantine item does not exist.", false);
    if (item.status === "restored") return restoreResult(item, this.now());
    try {
      const mode = await this.organization.mutationMode();
      if (mode.mode !== "live") throw new MutationGateChangedError("Global mutation mode changed to READ ONLY.");
      const root = await this.guard.validate(item.rootId, item.rootIdentityKey, { requireWrite: true });
      const quarantined = await safeExisting(this.guard, root, item.quarantinedRelativePath, this.#paths);
      if (quarantined === undefined) {
        const recovered = await safeExisting(this.guard, root, item.originalRelativePath, this.#paths);
        if (
          recovered !== undefined &&
          safeNumber((await lstat(recovered, { bigint: true })).size) === item.byteLength &&
          await sha256(recovered) === item.digestHex
        ) {
          const restored = await this.transfers.setQuarantineState(id, "restored", this.now(), {
            restoredAt: this.now(), restoreJobId: job.id,
          });
          return restoreResult(restored, this.now());
        }
        throw new Error("The quarantined file is missing or no longer verifiable.");
      }
      const stats = await lstat(quarantined, { bigint: true });
      if (safeNumber(stats.size) !== item.byteLength || await sha256(quarantined) !== item.digestHex) {
        throw new Error("The quarantined file failed content-identity verification.");
      }
      if (await safeExisting(this.guard, root, item.originalRelativePath, this.#paths) !== undefined) {
        throw new DestinationCollisionError("The original destination is occupied; restore was refused.");
      }
      const parent = portableDirname(item.originalRelativePath);
      await this.guard.authorizeProspectiveWrite(root, parent);
      await mkdir(this.#paths.join(root.canonicalPath, ...parent.split("/")), { recursive: true });
      const destination = await this.guard.authorizeProspectiveWrite(root, item.originalRelativePath);
      const currentMode = await this.organization.mutationMode();
      if (currentMode.mode !== "live") throw new MutationGateChangedError("Global mutation mode changed to READ ONLY.");
      const enrolled = await this.enrollments.get(item.rootId as never);
      if (enrolled?.approval.status !== "approved" || !enrolled.policy.allowWrites) {
        throw new MutationGateChangedError("Root write approval changed before restoration.");
      }
      await rename(quarantined, destination.canonicalPath);
      const verified = await this.guard.resolveExisting(root, item.originalRelativePath);
      if (await sha256(verified.canonicalPath) !== item.digestHex) {
        throw new JobHandlerFailure(
          "POST_RESTORE_VERIFICATION_INDETERMINATE",
          "The file was restored but final verification was interrupted; retry recovery.",
          true,
          { quarantineId: id },
        );
      }
      const restored = await this.transfers.setQuarantineState(id, "restored", this.now(), {
        restoredAt: this.now(), restoreJobId: job.id,
      });
      return restoreResult(restored, this.now());
    } catch (error) {
      if (error instanceof JobHandlerFailure) throw error;
      await this.transfers.setQuarantineState(id, "restore-blocked", this.now(), {
        restoreJobId: job.id,
        error: {
          code: error instanceof DestinationCollisionError ? "DESTINATION_COLLISION" : "RESTORE_FAILED",
          message: errorMessage(error),
        },
      });
      throw new JobHandlerFailure(
        error instanceof DestinationCollisionError ? "DESTINATION_COLLISION" : "RESTORE_FAILED",
        errorMessage(error),
        false,
        { quarantineId: id, quarantinedCopyPreserved: true },
      );
    }
  }

  private now(): string { return this.clock().toISOString(); }
}

class MutationGateChangedError extends Error {}
class DestinationCollisionError extends Error {
  public constructor(message = "The destination already exists with different content; no file was overwritten.") { super(message); }
}
class InsufficientSpaceError extends Error {
  public constructor(message = "The destination does not have enough free space for a verified transfer.") { super(message); }
}
class StaleSourceError extends Error {
  public constructor(message = "The source no longer matches the approved observation; it was preserved.") { super(message); }
}

function classifyItemError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof DestinationCollisionError) return { code: "DESTINATION_COLLISION", message: error.message, retryable: false };
  if (error instanceof InsufficientSpaceError) return { code: "INSUFFICIENT_DISK_SPACE", message: error.message, retryable: false };
  if (error instanceof StaleSourceError) return { code: "STALE_OR_DISAPPEARING_SOURCE", message: error.message, retryable: false };
  if (error instanceof TransferRootValidationError) return { code: error.code, message: error.message, retryable: false };
  if (error instanceof JobHandlerFailure) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "TRANSFER_ITEM_FAILED", message: errorMessage(error), retryable: true };
}

function executionErrorCode(error: unknown): string {
  if (error instanceof MutationGateChangedError) return "MUTATION_GATE_CHANGED";
  if (error instanceof TransferRootValidationError) return error.code;
  if (error instanceof JobHandlerFailure) return error.code;
  return "TRANSFER_EXECUTION_FAILED";
}

async function availableCapacity(canonicalRootPath: string): Promise<bigint> {
  const free = await statfs(canonicalRootPath, { bigint: true });
  return free.bavail * free.bsize;
}

async function safeExisting(
  guard: TransferRootGuard,
  root: ApprovedEnrolledRoot,
  relativePath: string,
  paths: path.PlatformPath,
): Promise<string | undefined> {
  try {
    return (await guard.resolveExisting(root, relativePath)).canonicalPath;
  } catch (error) {
    try { await lstat(paths.join(root.canonicalPath, ...relativePath.split("/"))); }
    catch (statError) { if (isNodeError(statError, "ENOENT")) return undefined; }
    throw error;
  }
}

async function sha256(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function matchesSource(stats: BigIntStats, item: DurableTransferItem): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && safeNumber(stats.size) === item.byteLength &&
    (item.sourceModifiedAt === undefined || stats.mtime.toISOString() === item.sourceModifiedAt) &&
    (item.sourceDeviceId === undefined || stats.dev.toString() === item.sourceDeviceId) &&
    (item.sourceFilesystemRecordId === undefined || stats.ino.toString() === item.sourceFilesystemRecordId);
}

function sameState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function stagingPath(planId: string, itemId: string): string {
  const plan = createHash("sha256").update(planId).digest("hex").slice(0, 24);
  const item = createHash("sha256").update(itemId).digest("hex");
  return `.local-librarian/transfer-staging/${plan}/${item}.part`;
}

function deterministicQuarantineId(planId: string, itemId: string): string {
  return `quarantine-v2:${createHash("sha256").update(planId).update("\0").update(itemId).digest("hex")}`;
}

function quarantinePath(id: string, filename: string): string {
  const directory = createHash("sha256").update(id).digest("hex");
  return `.local-librarian/quarantine/${directory}/${safeFilename(filename)}`;
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\0]/gu, "_").replace(/[. ]+$/u, "");
  return normalized.length === 0 ? "quarantined-file" : normalized;
}

function portableDirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? ".local-librarian/transfer-staging" : value.slice(0, index);
}

function checkpointOrdinal(value: JsonObject | undefined): number {
  const candidate = value?.["lastCompletedOrdinal"];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : -1;
}

function resultFor(
  plan: DurableTransferPlan,
  jobId: string,
  completedAt: string,
  receiptId?: string,
): StructuredJobResult {
  return {
    summary: {
      planId: plan.id,
      kind: plan.kind,
      status: plan.status,
      completed: plan.counts.completed,
      quarantined: plan.counts.quarantined,
      failed: plan.counts.failed,
      sourcePreservedOnFailure: true,
    },
    artifacts: receiptId === undefined ? [] : [{ kind: "ingest-receipt", id: receiptId }],
    completedAt,
  };
}

function restoreResult(item: QuarantineItem, completedAt: string): StructuredJobResult {
  return {
    summary: { quarantineId: item.id, status: item.status, restoredPath: item.originalRelativePath },
    artifacts: [{ kind: "other", id: item.id }],
    completedAt,
  };
}

function validatePlanPayload(payload: JsonObject): void {
  validateSingleStringPayload(payload, "planId");
}

function validateSingleStringPayload(payload: JsonObject, key: string): void {
  if (Object.keys(payload).length !== 1 || typeof payload[key] !== "string" || payload[key].trim().length === 0) {
    throw new Error(`Job payload must contain only a non-empty ${key}.`);
  }
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("File size exceeds the safe numeric range.");
  return result;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isNodeErrorOneOf(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String((error as NodeJS.ErrnoException).code));
}

function isCooperativeControl(error: unknown): boolean {
  return error instanceof Error && ["JobPauseRequested", "JobCancellationRequested"].includes(error.name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Transfer execution failed.";
}
