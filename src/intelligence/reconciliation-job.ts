import { createHash } from "node:crypto";

import type { JsonObject } from "../domain/index.js";
import type { JobClient } from "../jobs/index.js";
import {
  JobHandlerFailure,
  type JobDefinition,
  type JobExecutionContext,
  type JobHandler,
  type PersistentJobRecord,
  type StructuredJobResult,
} from "../jobs/index.js";
import type { SqliteIntelligenceStore } from "./intelligence-store.js";
import type {
  PersistedReconciliation,
  ReconciliationDeltaKind,
  ReconciliationDeltaPage,
} from "./types.js";

export const RECONCILIATION_JOB_DEFINITION: JobDefinition = {
  kind: "scans.reconcile",
  recoveryMode: "resume-from-checkpoint",
  validatePayload,
};

interface ReconciliationCheckpoint {
  readonly phase: "missing" | "added" | "changed";
  readonly afterRelativePath?: string;
}

export class ReconciliationJobHandler implements JobHandler {
  public readonly kind = "scans.reconcile" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;

  public constructor(
    private readonly store: SqliteIntelligenceStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    validatePayload(job.payload);
    const runId = job.payload["runId"] as string;
    let run = await this.store.reconciliation(runId);
    if (run === undefined) {
      throw new JobHandlerFailure("RECONCILIATION_NOT_FOUND", "The reconciliation run does not exist.", false);
    }
    if (run.status === "completed") return resultFor(run, this.clock().toISOString());
    let checkpoint = reconciliationCheckpoint(context.checkpoint, run.phase);
    try {
      run = await this.store.setReconciliationState(runId, {
        status: "running",
        phase: checkpoint.phase,
        updatedAt: this.clock().toISOString(),
      });
      const phases: readonly ReconciliationCheckpoint["phase"][] = ["missing", "added", "changed"];
      let phaseIndex = phases.indexOf(checkpoint.phase);
      if (phaseIndex < 0) phaseIndex = 0;
      for (; phaseIndex < phases.length; phaseIndex += 1) {
        const phase = phases[phaseIndex]!;
        const kind = kindForPhase(phase);
        for (;;) {
          await context.throwIfControlRequested();
          const items = await this.store.reconciliationWork(
            runId,
            kind,
            checkpoint.afterRelativePath,
            1_000,
          );
          if (items.length === 0) break;
          run = await this.store.saveReconciliationWork(
            runId,
            kind,
            items,
            this.clock().toISOString(),
          );
          const last = items.at(-1);
          checkpoint = {
            phase,
            ...(last === undefined ? {} : { afterRelativePath: last.relativePath }),
          };
          await context.saveCheckpoint(checkpointToJson(checkpoint));
          await context.reportProgress({
            phase: `reconciliation-${phase}`,
            completedUnits: run.processed,
            unit: "items",
            message: `Persisted ${run.processed.toLocaleString()} scan differences.`,
            metrics: {
              added: run.counts.added,
              missing: run.counts.missing,
              metadataChanged: run.counts.metadataChanged,
              currentPhase: phase,
            },
            updatedAt: this.clock().toISOString(),
          });
        }
        const next = phases[phaseIndex + 1];
        if (next !== undefined) {
          checkpoint = { phase: next };
          await context.saveCheckpoint(checkpointToJson(checkpoint));
          run = await this.store.setReconciliationState(runId, {
            status: "running",
            phase: next,
            updatedAt: this.clock().toISOString(),
          });
        }
      }
      run = await this.store.setReconciliationState(runId, {
        status: "completed",
        phase: "complete",
        updatedAt: this.clock().toISOString(),
      });
      return resultFor(run, this.clock().toISOString());
    } catch (error) {
      const cooperative = cooperativeStatus(error);
      await this.store.setReconciliationState(runId, {
        status: cooperative ?? "failed",
        phase: checkpoint.phase,
        ...(cooperative === undefined
          ? { error: { code: "RECONCILIATION_FAILED", message: errorMessage(error) } }
          : {}),
        updatedAt: this.clock().toISOString(),
      });
      if (cooperative !== undefined) throw error;
      throw new JobHandlerFailure("RECONCILIATION_FAILED", errorMessage(error), true, { runId });
    }
  }
}

export class ScalableReconciliationService {
  public constructor(
    private readonly store: SqliteIntelligenceStore,
    private readonly jobs: JobClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async compare(input: {
    readonly rootId: string;
    readonly baselineScanId: string;
    readonly comparisonScanId: string;
    readonly requestedBy: string;
  }): Promise<PersistedReconciliation> {
    if (input.baselineScanId === input.comparisonScanId) {
      throw new Error("Choose two different completed scans to compare.");
    }
    if (input.requestedBy.trim().length === 0) throw new Error("A reconciliation actor is required.");
    const id = reconciliationId(input.rootId, input.baselineScanId, input.comparisonScanId);
    let run = await this.store.createReconciliation({
      id,
      rootId: input.rootId,
      baselineScanId: input.baselineScanId,
      comparisonScanId: input.comparisonScanId,
      createdAt: this.clock().toISOString(),
    });
    if (run.jobId !== undefined || run.status === "completed") return run;
    const receipt = await this.jobs.submit({
      kind: "scans.reconcile",
      payload: { runId: id },
      priority: 15,
      idempotencyKey: `reconciliation:v2:${input.rootId}:${input.baselineScanId}:${input.comparisonScanId}`,
      requestedBy: input.requestedBy.trim(),
      controlPolicy: {
        pauseMode: "checkpoint",
        cancellationMode: "cooperative",
        maximumAttempts: 4,
        leaseDurationMilliseconds: 60_000,
      },
    });
    run = await this.store.attachReconciliationJob(id, receipt.jobId, this.clock().toISOString());
    return run;
  }

  public get(id: string): Promise<PersistedReconciliation | undefined> {
    return this.store.reconciliation(id);
  }

  public list(rootId?: string, limit?: number, cursor?: string) {
    return this.store.reconciliations(rootId, limit, cursor);
  }

  public deltas(
    id: string,
    input?: {
      readonly kind?: ReconciliationDeltaKind;
      readonly search?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ): Promise<ReconciliationDeltaPage> {
    return this.store.reconciliationDeltas(id, input);
  }
}

function validatePayload(payload: JsonObject): void {
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "runId" || typeof payload["runId"] !== "string" || payload["runId"].length === 0) {
    throw new Error("scans.reconcile payload must contain only a non-empty runId.");
  }
}

function reconciliationCheckpoint(
  value: JsonObject | undefined,
  fallback: PersistedReconciliation["phase"],
): ReconciliationCheckpoint {
  const phase = value?.["phase"] === "added" || value?.["phase"] === "changed" || value?.["phase"] === "missing"
    ? value["phase"]
    : fallback === "added" || fallback === "changed" || fallback === "missing"
      ? fallback
      : "missing";
  return {
    phase,
    ...(typeof value?.["afterRelativePath"] === "string"
      ? { afterRelativePath: value["afterRelativePath"] }
      : {}),
  };
}

function checkpointToJson(value: ReconciliationCheckpoint): JsonObject {
  return {
    phase: value.phase,
    ...(value.afterRelativePath === undefined ? {} : { afterRelativePath: value.afterRelativePath }),
  };
}

function kindForPhase(phase: ReconciliationCheckpoint["phase"]): ReconciliationDeltaKind {
  if (phase === "missing") return "missing";
  if (phase === "added") return "added";
  return "metadata-changed";
}

function resultFor(run: PersistedReconciliation, completedAt: string): StructuredJobResult {
  return {
    summary: {
      reconciliationId: run.id,
      rootId: run.rootId,
      baselineScanId: run.baselineScanId,
      comparisonScanId: run.comparisonScanId,
      status: run.status,
      added: run.counts.added,
      missing: run.counts.missing,
      metadataChanged: run.counts.metadataChanged,
    },
    artifacts: [{ kind: "catalog-query", id: run.id }],
    completedAt,
  };
}

function reconciliationId(rootId: string, baseline: string, comparison: string): string {
  const digest = createHash("sha256")
    .update(`reconciliation-v2\0${rootId}\0${baseline}\0${comparison}\0`)
    .digest("hex");
  return `reconciliation-v2:${digest}`;
}

function cooperativeStatus(error: unknown): "paused" | "cancelled" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "JobPauseRequested") return "paused";
  if (error.name === "JobCancellationRequested") return "cancelled";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Reconciliation failed.";
}
