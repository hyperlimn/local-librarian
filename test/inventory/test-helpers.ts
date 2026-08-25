import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type {
  ApprovedLibraryRoot,
  FilesystemVolumeIdentity,
  WorkerId,
} from "../../src/domain/index.js";
import {
  SqliteInventoryCatalog,
  type InventoryCatalog,
} from "../../src/catalog/index.js";
import {
  JsonlRootEnrollmentStore,
  RootEnrollmentService,
  type VolumeIdentityProvider,
} from "../../src/enrollment/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../../src/jobs/index.js";
import { InventoryTools } from "../../src/mcp/index.js";
import {
  ORGANIZATION_EXECUTE_JOB_DEFINITION,
  ORGANIZATION_ROLLBACK_JOB_DEFINITION,
} from "../../src/organization/index.js";
import {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
  type CanonicalPathInspection,
} from "../../src/safety/index.js";
import {
  INVENTORY_SCAN_JOB_DEFINITION,
  InventoryRootGuard,
  InventoryScanJobHandler,
  type InventoryScanHandlerOptions,
} from "../../src/scanner/index.js";

export interface InventoryTestFixture {
  readonly directory: string;
  readonly rootPath: string;
  readonly statePath: string;
  readonly enrollmentPath: string;
  readonly jobsPath: string;
  readonly inventoryPath: string;
  readonly store: JsonlRootEnrollmentStore;
  readonly service: RootEnrollmentService;
  readonly root: ApprovedLibraryRoot;
  cleanup(): Promise<void>;
}

export async function createInventoryFixture(): Promise<InventoryTestFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-inventory-"));
  const rootPath = path.join(directory, "library");
  const statePath = path.join(directory, "state");
  await mkdir(rootPath);
  await mkdir(statePath);
  const enrollmentPath = path.join(statePath, "enrollments.jsonl");
  const store = new JsonlRootEnrollmentStore(enrollmentPath);
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  const service = new RootEnrollmentService(
    canonicalizer,
    new TestVolumeIdentityProvider(),
    store,
  );
  const proposal = await service.propose({
    role: "library",
    path: rootPath,
    displayName: "Test library",
  });
  const root = await service.approve(proposal.proposalId, "test-user");
  if (!("controlDirectory" in root.policy)) throw new Error("Expected a library root.");
  return {
    directory,
    rootPath,
    statePath,
    enrollmentPath,
    jobsPath: path.join(statePath, "jobs.sqlite"),
    inventoryPath: path.join(statePath, "inventory.sqlite"),
    store,
    service,
    root: root as ApprovedLibraryRoot,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function createJobQueue(databasePath: string): SqlitePersistentJobQueue {
  return new SqlitePersistentJobQueue({
    databasePath,
    definitions: [
      INVENTORY_SCAN_JOB_DEFINITION,
      ORGANIZATION_EXECUTE_JOB_DEFINITION,
      ORGANIZATION_ROLLBACK_JOB_DEFINITION,
    ],
  });
}

export function createCatalog(databasePath: string): SqliteInventoryCatalog {
  return new SqliteInventoryCatalog({ databasePath });
}

export function createRootGuard(
  store: JsonlRootEnrollmentStore,
): InventoryRootGuard {
  const canonicalizer = new ReadOnlyCanonicalPathResolver();
  return new InventoryRootGuard(
    store,
    canonicalizer,
    new TestVolumeIdentityProvider(),
    new ReadOnlyRootPathResolver(
      canonicalizer,
      new PathBoundary(process.platform === "win32" ? "win32" : "posix"),
    ),
  );
}

export function createInventoryWorker(
  queue: SqlitePersistentJobQueue,
  catalog: SqliteInventoryCatalog,
  store: JsonlRootEnrollmentStore,
  options: InventoryScanHandlerOptions = {},
  workerId = "inventory-test-worker",
): PersistentLocalWorker {
  return new PersistentLocalWorker({
    id: workerId as WorkerId,
    queue,
    handlers: [
      new InventoryScanJobHandler(createRootGuard(store), catalog, options),
    ],
  });
}

export function createInventoryTools(
  queue: SqlitePersistentJobQueue,
  catalog: InventoryCatalog,
  fixture: Pick<InventoryTestFixture, "store">,
): InventoryTools {
  return new InventoryTools(queue, fixture.store, catalog);
}

export class TestVolumeIdentityProvider implements VolumeIdentityProvider {
  public identify(
    inspection: CanonicalPathInspection,
  ): Promise<FilesystemVolumeIdentity> {
    return Promise.resolve({
      kind: "filesystem-device",
      key: `test-volume:${inspection.deviceId}`,
      stability: "best-effort",
      deviceId: inspection.deviceId,
      ...(inspection.fileSystemTypeCode === undefined
        ? {}
        : { fileSystemTypeCode: inspection.fileSystemTypeCode }),
      mountPathAtEnrollment: inspection.mountPath,
    });
  }
}
