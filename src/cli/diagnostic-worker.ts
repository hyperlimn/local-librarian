import type { WorkerId } from "../domain/index.js";
import {
  DIAGNOSTIC_COUNT_JOB_DEFINITION,
  DiagnosticCountJobHandler,
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../jobs/index.js";

async function main(): Promise<void> {
  const [databasePath, mode] = process.argv.slice(2);
  if (databasePath === undefined) {
    throw new Error("Usage: diagnostic-worker <database> [--once]");
  }

  const queue = new SqlitePersistentJobQueue({
    databasePath,
    definitions: [DIAGNOSTIC_COUNT_JOB_DEFINITION],
  });
  const worker = new PersistentLocalWorker({
    id: `diagnostic-worker-${process.pid}` as WorkerId,
    queue,
    handlers: [new DiagnosticCountJobHandler()],
  });
  const stop = (): void => worker.requestStop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    if (mode === "--once") {
      const outcome = await worker.runOnce();
      process.stdout.write(`${JSON.stringify({ outcome })}\n`);
    } else if (mode === undefined) {
      process.stdout.write(`${JSON.stringify({ workerId: worker.id, status: "started" })}\n`);
      await worker.runUntilStopped();
    } else {
      throw new Error(`Unknown worker option: ${mode}`);
    }
  } finally {
    queue.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

