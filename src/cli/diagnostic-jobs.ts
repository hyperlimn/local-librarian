import type { JobId } from "../domain/index.js";
import {
  DIAGNOSTIC_COUNT_JOB_DEFINITION,
  SqlitePersistentJobQueue,
} from "../jobs/index.js";
import { DiagnosticJobTools } from "../mcp/index.js";

async function main(): Promise<void> {
  const [command, databasePath, ...arguments_] = process.argv.slice(2);
  if (command === undefined || databasePath === undefined) {
    throw new Error(
      "Usage: diagnostic-jobs <submit|status|result|history|pause|resume|cancel> <database> [arguments]",
    );
  }

  const queue = new SqlitePersistentJobQueue({
    databasePath,
    definitions: [DIAGNOSTIC_COUNT_JOB_DEFINITION],
  });
  const tools = new DiagnosticJobTools(queue);
  try {
    let output: unknown;
    if (command === "submit") {
      const iterations = parsePositiveInteger(arguments_[0], "iterations");
      const idempotencyKey = required(arguments_[1], "idempotency key");
      output = await tools.submit({ iterations, idempotencyKey, requestedBy: "diagnostic-cli" });
    } else {
      const jobId = required(arguments_[0], "job ID") as JobId;
      switch (command) {
        case "status":
          output = await tools.status(jobId);
          break;
        case "result":
          output = await tools.result(jobId);
          break;
        case "history":
          output = await tools.history(jobId);
          break;
        case "pause":
          output = await tools.pause(jobId, "diagnostic-cli");
          break;
        case "resume":
          output = await tools.resume(jobId, "diagnostic-cli");
          break;
        case "cancel":
          output = await tools.cancel(jobId, "diagnostic-cli");
          break;
        default:
          throw new Error(`Unknown command: ${command}`);
      }
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    queue.close();
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(required(value, name));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

