import type { JsonObject, WorkerId } from "../domain/index.js";
import type {
  JobLease,
  WorkerControlSignal,
  WorkerJobQueue,
} from "./job-queue.js";
import type {
  JobProgress,
  JobKind,
  StructuredJobError,
} from "./job.js";
import type {
  JobExecutionContext,
  JobHandler,
  LocalWorker,
} from "./worker.js";
import { JobHandlerFailure } from "./worker.js";

export interface PersistentLocalWorkerOptions {
  readonly id: WorkerId;
  readonly queue: WorkerJobQueue;
  readonly handlers: readonly JobHandler[];
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class JobPauseRequested extends Error {
  public constructor() {
    super("The job cooperatively paused.");
    this.name = "JobPauseRequested";
  }
}

export class JobCancellationRequested extends Error {
  public constructor() {
    super("The job cooperatively cancelled.");
    this.name = "JobCancellationRequested";
  }
}

/**
 * Runs outside the MCP request lifecycle. Multiple worker processes may share
 * a database; lease ownership makes each claim exclusive.
 */
export class PersistentLocalWorker implements LocalWorker {
  public readonly id: WorkerId;
  public readonly queue: WorkerJobQueue;
  public readonly supportedKinds: readonly JobKind[];
  readonly #handlers: ReadonlyMap<JobKind, JobHandler>;
  readonly #clock: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #stopRequested = false;

  public constructor(options: PersistentLocalWorkerOptions) {
    this.id = options.id;
    this.queue = options.queue;
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? sleep;
    const handlers = new Map<JobKind, JobHandler>();
    for (const handler of options.handlers) {
      if (handlers.has(handler.kind)) throw new Error(`Duplicate handler: ${handler.kind}`);
      handlers.set(handler.kind, handler);
    }
    this.#handlers = handlers;
    this.supportedKinds = [...handlers.keys()];
  }

  public async runOnce(): Promise<"worked" | "idle"> {
    await this.queue.recoverExpiredLeases(this.#clock().toISOString());
    const lease = await this.queue.claimNext(this.id, this.supportedKinds);
    if (lease === undefined) return "idle";

    const job = await this.queue.loadLeasedJob(lease);
    const handler = this.#handlers.get(job.kind);
    if (handler === undefined) {
      await this.queue.fail(lease, structuredError(
        "HANDLER_NOT_AVAILABLE",
        `Worker ${this.id} has no handler for ${job.kind}.`,
        false,
        this.#clock().toISOString(),
      ));
      return "worked";
    }

    const context = new DurableExecutionContext(this.queue, lease, job.checkpoint);
    try {
      const result = await handler.run(job, context);
      await context.throwIfControlRequested();
      await this.queue.complete(context.currentLease, result);
    } catch (error) {
      if (error instanceof JobPauseRequested) {
        await this.queue.acknowledgePaused(
          context.currentLease,
          context.latestCheckpoint,
        );
      } else if (error instanceof JobCancellationRequested) {
        await this.queue.acknowledgeCancelled(context.currentLease, {
          reason: "cooperative-cancellation",
        });
      } else {
        const failure = error instanceof JobHandlerFailure
          ? structuredError(
              error.code,
              error.message,
              error.retryable,
              this.#clock().toISOString(),
              error.details,
            )
          : structuredError(
              "JOB_HANDLER_FAILED",
              error instanceof Error ? error.message : "The job handler failed.",
              true,
              this.#clock().toISOString(),
            );
        await this.queue.fail(context.currentLease, failure);
      }
    }
    return "worked";
  }

  public async runUntilStopped(pollIntervalMilliseconds = 250): Promise<void> {
    if (!Number.isInteger(pollIntervalMilliseconds) || pollIntervalMilliseconds < 1) {
      throw new Error("pollIntervalMilliseconds must be a positive integer.");
    }
    this.#stopRequested = false;
    while (!this.#stopRequested) {
      const outcome = await this.runOnce();
      if (outcome === "idle" && !this.#stopRequested) {
        await this.#sleep(pollIntervalMilliseconds);
      }
    }
  }

  public requestStop(): void {
    this.#stopRequested = true;
  }
}

class DurableExecutionContext implements JobExecutionContext {
  readonly #queue: WorkerJobQueue;
  #lease: JobLease;
  #checkpoint: JsonObject | undefined;

  public constructor(
    queue: WorkerJobQueue,
    lease: JobLease,
    checkpoint: JsonObject | undefined,
  ) {
    this.#queue = queue;
    this.#lease = lease;
    this.#checkpoint = checkpoint;
  }

  public get lease(): JobLease {
    return this.#lease;
  }

  public get checkpoint(): JsonObject | undefined {
    return this.#checkpoint;
  }

  public get currentLease(): JobLease {
    return this.#lease;
  }

  public get latestCheckpoint(): JsonObject | undefined {
    return this.#checkpoint;
  }

  public async reportProgress(progress: JobProgress): Promise<void> {
    this.#lease = await this.#queue.heartbeat(this.#lease, progress);
  }

  public async saveCheckpoint(checkpoint: JsonObject): Promise<void> {
    await this.#queue.saveCheckpoint(this.#lease, checkpoint);
    this.#checkpoint = checkpoint;
  }

  public async controlSignal(): Promise<WorkerControlSignal> {
    return this.#queue.controlSignal(this.#lease);
  }

  public async throwIfControlRequested(): Promise<void> {
    const signal = await this.controlSignal();
    if (signal === "pause") throw new JobPauseRequested();
    if (signal === "cancel") throw new JobCancellationRequested();
  }
}

function structuredError(
  code: string,
  message: string,
  retryable: boolean,
  occurredAt: string,
  details: JsonObject = {},
): StructuredJobError {
  return { code, message, retryable, details, occurredAt };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
