import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerStatusStore } from "../../src/jobs/index.js";
import {
  LocalWorkerProcessManager,
  type WorkerProcessStarter,
} from "../../src/web/worker-process-manager.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("LocalWorkerProcessManager", () => {
  it("launches a distinct process and returns without creating an in-process worker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-web-worker-"));
    directories.push(directory);
    const starter = new CapturingStarter();
    const entry = path.join(directory, "local-worker.js");
    const clock = () => new Date("2026-08-18T10:00:00.000Z");
    const manager = new LocalWorkerProcessManager({
      stateDirectory: directory,
      statusStore: new WorkerStatusStore(path.join(directory, "worker-status.json"), clock),
      workerEntryPath: entry,
      starter,
      clock,
    });

    const status = await manager.start();
    expect(starter.calls).toEqual([{
      executable: process.execPath,
      arguments: [entry, directory],
    }]);
    expect(status).toMatchObject({ status: "starting", pid: 42_424, workerId: "local-worker-42424" });
    expect(await manager.start()).toMatchObject({ status: "starting" });
    expect(starter.calls).toHaveLength(1);
  });
});

class CapturingStarter implements WorkerProcessStarter {
  public readonly calls: Array<{ executable: string; arguments: readonly string[] }> = [];
  public start(executable: string, arguments_: readonly string[]): number {
    this.calls.push({ executable, arguments: arguments_ });
    return 42_424;
  }
}
