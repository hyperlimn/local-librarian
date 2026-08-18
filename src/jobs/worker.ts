import type {
  JobLease,
  WorkerControlSignal,
  WorkerJobQueue,
} from "./job-queue.js";
import type {
  JobProgress,
  JobKind,
  JobRecoveryMode,
  PersistentJobRecord,
  StructuredJobResult,
} from "./job.js";
import type { JsonObject, WorkerId } from "../domain/index.js";

export interface JobExecutionContext {
  readonly lease: JobLease;
  readonly checkpoint: JsonObject | undefined;
  reportProgress(progress: JobProgress): Promise<void>;
  saveCheckpoint(checkpoint: JsonObject): Promise<void>;
  controlSignal(): Promise<WorkerControlSignal>;
  /** Throws a typed cooperative-control signal for handlers that opt in. */
  throwIfControlRequested(): Promise<void>;
}

export interface JobHandler {
  readonly kind: JobKind;
  readonly recoveryMode: JobRecoveryMode;
  run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult>;
}

/** Lets a handler return a stable structured failure and retry decision. */
export class JobHandlerFailure extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "JobHandlerFailure";
  }
}

export interface LocalWorker {
  readonly id: WorkerId;
  readonly queue: WorkerJobQueue;
  readonly supportedKinds: readonly JobKind[];
  /** Performs at most one leased job, outside any MCP request lifecycle. */
  runOnce(): Promise<"worked" | "idle">;
  runUntilStopped(pollIntervalMilliseconds?: number): Promise<void>;
  requestStop(): void;
}

export interface WorkerFactory {
  create(handlers: readonly JobHandler[]): LocalWorker;
}

export const LOCAL_WORKER_IMPLEMENTATION_STATUS = "diagnostic-and-inventory" as const;
