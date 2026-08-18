import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { WorkerId } from "../domain/index.js";
import {
  WorkerStatusStore,
  type WorkerStatusView,
} from "../jobs/index.js";

export interface WorkerProcessStarter {
  start(executable: string, arguments_: readonly string[]): number | undefined;
}

export interface WorkerManager {
  status(): Promise<WorkerStatusView>;
  start(): Promise<WorkerStatusView>;
}

export interface LocalWorkerProcessManagerOptions {
  readonly stateDirectory: string;
  readonly statusStore: WorkerStatusStore;
  readonly workerEntryPath?: string;
  readonly starter?: WorkerProcessStarter;
  readonly clock?: () => Date;
}

/** Starts a detached process; no worker loop executes inside the web server. */
export class LocalWorkerProcessManager implements WorkerManager {
  readonly #stateDirectory: string;
  readonly #statusStore: WorkerStatusStore;
  readonly #workerEntryPath: string;
  readonly #starter: WorkerProcessStarter;
  readonly #clock: () => Date;

  public constructor(options: LocalWorkerProcessManagerOptions) {
    this.#stateDirectory = options.stateDirectory;
    this.#statusStore = options.statusStore;
    this.#workerEntryPath = options.workerEntryPath ?? fileURLToPath(
      new URL("../cli/local-worker.js", import.meta.url),
    );
    this.#starter = options.starter ?? new DetachedNodeProcessStarter();
    this.#clock = options.clock ?? (() => new Date());
  }

  public status(): Promise<WorkerStatusView> {
    return this.#statusStore.view();
  }

  public async start(): Promise<WorkerStatusView> {
    const current = await this.status();
    if (current.status === "running" || current.status === "starting") return current;
    const pid = this.#starter.start(process.execPath, [
      this.#workerEntryPath,
      this.#stateDirectory,
    ]);
    if (pid === undefined) throw new Error("The local worker process did not start.");
    const now = this.#clock().toISOString();
    await this.#statusStore.write({
      workerId: `local-worker-${pid}` as WorkerId,
      pid,
      status: "starting",
      startedAt: now,
      heartbeatAt: now,
    });
    return this.#statusStore.view();
  }
}

class DetachedNodeProcessStarter implements WorkerProcessStarter {
  public start(executable: string, arguments_: readonly string[]): number | undefined {
    const child = spawn(executable, [...arguments_], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  }
}

