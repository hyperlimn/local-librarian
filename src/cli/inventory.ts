import type {
  InventoryRecordId,
  InventoryScanId,
  JobId,
  LibraryRootId,
} from "../domain/index.js";
import { SqliteInventoryCatalog } from "../catalog/index.js";
import { JsonlRootEnrollmentStore } from "../enrollment/index.js";
import {
  DIAGNOSTIC_COUNT_JOB_DEFINITION,
  SqlitePersistentJobQueue,
} from "../jobs/index.js";
import { InventoryTools } from "../mcp/index.js";
import { INVENTORY_SCAN_JOB_DEFINITION } from "../scanner/index.js";
import { localStatePaths } from "./local-state.js";

async function main(): Promise<void> {
  const [command, stateDirectory, identifier, ...arguments_] = process.argv.slice(2);
  if (command === undefined || stateDirectory === undefined || identifier === undefined) {
    throw new Error(
      "Usage: inventory <submit|summary|list|get|status|result|history|pause|resume|cancel> <state-directory> <id> [arguments]",
    );
  }
  const paths = localStatePaths(stateDirectory);
  const jobs = new SqlitePersistentJobQueue({
    databasePath: paths.jobsDatabase,
    definitions: [DIAGNOSTIC_COUNT_JOB_DEFINITION, INVENTORY_SCAN_JOB_DEFINITION],
  });
  const catalog = new SqliteInventoryCatalog({
    databasePath: paths.inventoryDatabase,
  });
  const tools = new InventoryTools(
    jobs,
    new JsonlRootEnrollmentStore(paths.enrollmentsJournal),
    catalog,
  );
  try {
    let output: unknown;
    switch (command) {
      case "submit":
        output = await tools.scan({
          rootId: identifier as LibraryRootId,
          idempotencyKey: required(arguments_[0], "idempotency key"),
          requestedBy: "local-cli",
        });
        break;
      case "summary":
        output = await tools.summary(identifier as LibraryRootId);
        break;
      case "list":
        output = await tools.list(identifier as LibraryRootId, {
          ...(arguments_[0] === undefined
            ? {}
            : { limit: parsePositiveInteger(arguments_[0], "limit") }),
          ...(arguments_[1] === undefined ? {} : { cursor: arguments_[1] }),
          ...(arguments_[2] === undefined
            ? {}
            : { scanId: arguments_[2] as InventoryScanId }),
        });
        break;
      case "get":
        output = await tools.get(identifier as InventoryRecordId);
        break;
      case "status":
        output = await jobs.status(identifier as JobId);
        break;
      case "result":
        output = await jobs.result(identifier as JobId);
        break;
      case "history":
        output = await jobs.history(identifier as JobId);
        break;
      case "pause":
        output = await jobs.requestPause(identifier as JobId, "local-cli");
        break;
      case "resume":
        output = await jobs.resume(identifier as JobId, "local-cli");
        break;
      case "cancel":
        output = await jobs.cancel(identifier as JobId, "local-cli");
        break;
      default:
        throw new Error(`Unknown inventory command: ${command}`);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    catalog.close();
    jobs.close();
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive.`);
  return parsed;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

