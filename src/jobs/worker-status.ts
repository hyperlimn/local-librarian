import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { WorkerId } from "../domain/index.js";

export type WorkerRuntimeStatus = "starting" | "running" | "stopped";

export interface WorkerRuntimeRecord {
  readonly workerId: WorkerId;
  readonly pid: number;
  readonly status: WorkerRuntimeStatus;
  readonly startedAt: string;
  readonly heartbeatAt: string;
}

export interface WorkerStatusView {
  readonly status: "offline" | "starting" | "running" | "stale";
  readonly workerId?: WorkerId;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly heartbeatAt?: string;
}

/** App-state-only heartbeat; it never writes inside an enrolled library. */
export class WorkerStatusStore {
  public constructor(
    private readonly statusPath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async write(record: WorkerRuntimeRecord): Promise<void> {
    await mkdir(dirname(this.statusPath), { recursive: true });
    await writeFile(this.statusPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  public async read(): Promise<WorkerRuntimeRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.statusPath, "utf8")) as unknown;
      return isWorkerRecord(value) ? value : undefined;
    } catch (error) {
      if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  public async view(staleAfterMilliseconds = 10_000): Promise<WorkerStatusView> {
    const record = await this.read();
    if (record === undefined || record.status === "stopped") return { status: "offline" };
    const age = this.clock().getTime() - new Date(record.heartbeatAt).getTime();
    const status = age > staleAfterMilliseconds
      ? "stale"
      : record.status === "starting"
        ? "starting"
        : "running";
    return {
      status,
      workerId: record.workerId,
      pid: record.pid,
      startedAt: record.startedAt,
      heartbeatAt: record.heartbeatAt,
    };
  }
}

export class WorkerHeartbeat {
  readonly #startedAt: string;
  #timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly store: WorkerStatusStore,
    private readonly workerId: WorkerId,
    private readonly pid: number,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#startedAt = clock().toISOString();
  }

  public async start(intervalMilliseconds = 2_000): Promise<void> {
    await this.write("running");
    this.#timer = setInterval(() => {
      void this.write("running").catch(() => undefined);
    }, intervalMilliseconds);
    this.#timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.write("stopped");
  }

  private write(status: "running" | "stopped"): Promise<void> {
    return this.store.write({
      workerId: this.workerId,
      pid: this.pid,
      status,
      startedAt: this.#startedAt,
      heartbeatAt: this.clock().toISOString(),
    });
  }
}

function isWorkerRecord(value: unknown): value is WorkerRuntimeRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["workerId"] === "string" &&
    typeof record["pid"] === "number" &&
    Number.isInteger(record["pid"]) &&
    (record["status"] === "starting" ||
      record["status"] === "running" ||
      record["status"] === "stopped") &&
    typeof record["startedAt"] === "string" &&
    typeof record["heartbeatAt"] === "string"
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

