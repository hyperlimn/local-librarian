import type { JsonObject } from "../domain/index.js";
import type {
  JobDefinition,
  JobProgress,
  PersistentJobRecord,
  StructuredJobResult,
} from "./job.js";
import type { JobExecutionContext, JobHandler } from "./worker.js";

export interface DiagnosticCountPayload extends JsonObject {
  readonly iterations: number;
}

export interface DiagnosticCountCheckpoint extends JsonObject {
  readonly completedIterations: number;
}

export interface DiagnosticCountHandlerOptions {
  readonly delayMilliseconds?: number;
  readonly checkpointEvery?: number;
  readonly progressEvery?: number;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export const DIAGNOSTIC_COUNT_JOB_DEFINITION: JobDefinition = {
  kind: "diagnostic.count",
  recoveryMode: "resume-from-checkpoint",
  validatePayload(payload): void {
    const keys = Object.keys(payload);
    if (keys.length !== 1 || keys[0] !== "iterations") {
      throw new Error("diagnostic.count payload must contain only iterations.");
    }
    const iterations = payload["iterations"];
    if (
      typeof iterations !== "number" ||
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > 1_000_000
    ) {
      throw new Error("diagnostic.count iterations must be an integer from 1 to 1,000,000.");
    }
  },
};

/** Harmless proof job: it only waits, counts in memory, and persists queue state. */
export class DiagnosticCountJobHandler implements JobHandler {
  public readonly kind = "diagnostic.count" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #delayMilliseconds: number;
  readonly #checkpointEvery: number;
  readonly #progressEvery: number;
  readonly #clock: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  public constructor(options: DiagnosticCountHandlerOptions = {}) {
    this.#delayMilliseconds = positiveInteger(options.delayMilliseconds ?? 25, "delayMilliseconds", true);
    this.#checkpointEvery = positiveInteger(options.checkpointEvery ?? 5, "checkpointEvery");
    this.#progressEvery = positiveInteger(options.progressEvery ?? 5, "progressEvery");
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? sleep;
  }

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    DIAGNOSTIC_COUNT_JOB_DEFINITION.validatePayload(job.payload);
    const iterations = job.payload["iterations"] as number;
    const completed = checkpointCount(job.checkpoint, iterations);

    for (let count = completed + 1; count <= iterations; count += 1) {
      await context.throwIfControlRequested();
      await this.#sleep(this.#delayMilliseconds);

      if (count % this.#checkpointEvery === 0 || count === iterations) {
        await context.saveCheckpoint({ completedIterations: count });
      }
      if (count % this.#progressEvery === 0 || count === iterations) {
        await context.reportProgress(progress(count, iterations, this.#clock().toISOString()));
      }
    }

    return {
      summary: {
        kind: "diagnostic.count",
        iterations,
        counted: iterations,
      },
      artifacts: [],
      completedAt: this.#clock().toISOString(),
    };
  }
}

function checkpointCount(checkpoint: JsonObject | undefined, iterations: number): number {
  if (checkpoint === undefined) return 0;
  const completed = checkpoint["completedIterations"];
  if (
    typeof completed !== "number" ||
    !Number.isInteger(completed) ||
    completed < 0 ||
    completed > iterations
  ) {
    throw new Error("diagnostic.count checkpoint is invalid.");
  }
  return completed;
}

function progress(completed: number, total: number, updatedAt: string): JobProgress {
  return {
    phase: "counting",
    completedUnits: completed,
    totalUnits: total,
    unit: "steps",
    percent: (completed / total) * 100,
    message: `Counted ${completed} of ${total}.`,
    updatedAt,
  };
}

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

