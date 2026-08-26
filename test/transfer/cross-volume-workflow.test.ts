import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteInventoryCatalog } from "../../src/catalog/index.js";
import type {
  InventoryRecord,
  InventoryRecordId,
  InventoryScanId,
  FilesystemVolumeIdentity,
  JobId,
  LibraryRootId,
  RootRelativePath,
  WorkerId,
} from "../../src/domain/index.js";
import {
  JsonlRootEnrollmentStore,
  RootEnrollmentService,
  type VolumeIdentityProvider,
} from "../../src/enrollment/index.js";
import { SqliteIntelligenceStore } from "../../src/intelligence/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
} from "../../src/jobs/index.js";
import { SqliteOrganizationStore } from "../../src/organization/index.js";
import {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
  type CanonicalPathInspection,
} from "../../src/safety/index.js";
import { INVENTORY_SCAN_JOB_DEFINITION } from "../../src/scanner/index.js";
import {
  CROSS_VOLUME_TRANSFER_JOB_DEFINITION,
  QUARANTINE_RESTORE_JOB_DEFINITION,
  CrossVolumeTransferJobHandler,
  QuarantineRestoreJobHandler,
  SqliteTransferStore,
  TransferRootGuard,
  TransferService,
} from "../../src/transfer/index.js";

interface Resources {
  readonly directory: string;
  readonly catalog: SqliteInventoryCatalog;
  readonly intelligence: SqliteIntelligenceStore;
  readonly organization: SqliteOrganizationStore;
  readonly transfers: SqliteTransferStore;
  readonly queue: SqlitePersistentJobQueue;
}

const resources: Resources[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.queue.close();
    resource.transfers.close();
    resource.organization.close();
    resource.intelligence.close();
    resource.catalog.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

describe("verified cross-volume organization", () => {
  it("copies, verifies, quarantines the source, and restores it across simulated volumes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-cross-volume-"));
    const sourcePath = path.join(directory, "source-library");
    const destinationPath = path.join(directory, "destination-library");
    const statePath = path.join(directory, "state");
    await Promise.all([mkdir(sourcePath), mkdir(destinationPath), mkdir(statePath)]);

    const enrollmentStore = new JsonlRootEnrollmentStore(path.join(statePath, "enrollments.jsonl"));
    const canonicalizer = new ReadOnlyCanonicalPathResolver();
    const volumes = new SimulatedVolumeIdentityProvider();
    const enrollment = new RootEnrollmentService(canonicalizer, volumes, enrollmentStore);
    const sourceProposal = await enrollment.propose({
      role: "library",
      path: sourcePath,
      displayName: "Source volume",
    });
    const destinationProposal = await enrollment.propose({
      role: "library",
      path: destinationPath,
      displayName: "Destination volume",
    });
    const source = await enrollment.approve(sourceProposal.proposalId, "test-user");
    const destination = await enrollment.approve(destinationProposal.proposalId, "test-user");
    await enrollment.setLibraryWriteAccess(source.id as LibraryRootId, true, "test-user");
    await enrollment.setLibraryWriteAccess(destination.id as LibraryRootId, true, "test-user");
    expect(source.identity.volume.key).not.toBe(destination.identity.volume.key);

    const inventoryPath = path.join(statePath, "inventory.sqlite");
    const catalog = new SqliteInventoryCatalog({ databasePath: inventoryPath });
    const intelligence = new SqliteIntelligenceStore({ databasePath: inventoryPath });
    const organization = new SqliteOrganizationStore({
      databasePath: path.join(statePath, "organization.sqlite"),
    });
    await organization.setMutationMode("live", "test-user");
    const transfers = new SqliteTransferStore(path.join(statePath, "transfers.sqlite"));
    const queue = new SqlitePersistentJobQueue({
      databasePath: path.join(statePath, "jobs.sqlite"),
      definitions: [
        CROSS_VOLUME_TRANSFER_JOB_DEFINITION,
        QUARANTINE_RESTORE_JOB_DEFINITION,
        INVENTORY_SCAN_JOB_DEFINITION,
      ],
    });
    resources.push({ directory, catalog, intelligence, organization, transfers, queue });

    const payload = Buffer.from("verified cross-volume fixture", "utf8");
    const sourceFile = path.join(sourcePath, "archive.dat");
    await writeFile(sourceFile, payload);
    const stats = await lstat(sourceFile, { bigint: true });
    const scanId = "cross-volume-source-scan" as InventoryScanId;
    const jobId = "cross-volume-source-job" as JobId;
    const record: InventoryRecord = {
      id: "cross-volume-record" as InventoryRecordId,
      scanId,
      rootId: source.id as LibraryRootId,
      jobId,
      relativePath: "archive.dat" as RootRelativePath,
      name: "archive.dat",
      extension: "dat",
      entryType: "file",
      observationStatus: "observed",
      byteLength: payload.byteLength,
      modifiedAt: stats.mtime.toISOString(),
      deviceId: stats.dev.toString(),
      filesystemRecordId: stats.ino.toString(),
      attributes: { hidden: false, system: false, readOnly: false },
      contentIdentity: { status: "not-requested" },
      observedAt: "2026-03-01T00:00:00.000Z",
    };
    await catalog.startOrLoadScan({
      id: scanId,
      rootId: source.id as LibraryRootId,
      jobId,
      rootIdentityKey: source.identity.key,
      startedAt: record.observedAt,
    });
    await catalog.writeBatch(scanId, {
      observations: [record],
      discoveredDirectories: [],
    }, record.observedAt);
    await catalog.setScanStatus(scanId, "completed", record.observedAt);
    const hashTask = (await intelligence.hashTasks(scanId, "all", 10))[0]!;
    const digest = createHash("sha256").update(payload).digest("hex");
    await intelligence.saveHash(
      hashTask,
      digest,
      "2026-03-01T00:01:00.000Z",
      "verified",
    );

    const boundary = new PathBoundary(process.platform === "win32" ? "win32" : "posix");
    const resolver = new ReadOnlyRootPathResolver(canonicalizer, boundary);
    const guard = new TransferRootGuard(
      enrollmentStore,
      canonicalizer,
      volumes,
      resolver,
      boundary,
    );
    const worker = new PersistentLocalWorker({
      id: "cross-volume-worker" as WorkerId,
      queue,
      handlers: [
        new CrossVolumeTransferJobHandler(
          guard,
          transfers,
          organization,
          enrollmentStore,
          intelligence,
          queue,
        ),
        new QuarantineRestoreJobHandler(
          guard,
          transfers,
          organization,
          enrollmentStore,
        ),
      ],
    });
    const service = new TransferService(
      transfers,
      queue,
      enrollmentStore,
      organization,
      catalog,
      intelligence,
    );

    const plan = await service.createCrossVolumePlan({
      sourceRootId: source.id as LibraryRootId,
      destinationRootId: destination.id as LibraryRootId,
      recordIds: [record.id],
      targetDirectory: "Relocated",
      preserveSourceFolders: false,
      requestedBy: "test-user",
    });
    await service.approve(plan.id, "test-user", "TRANSFER 1 FILES");
    await worker.runOnce();

    const destinationFile = path.join(destinationPath, "Relocated", "archive.dat");
    await expect(readFile(destinationFile)).resolves.toEqual(payload);
    await expect(pathExists(sourceFile)).resolves.toBe(false);
    expect(createHash("sha256").update(await readFile(destinationFile)).digest("hex")).toBe(digest);
    expect(await transfers.plan(plan.id)).toMatchObject({
      status: "completed",
      counts: { quarantined: 1, failed: 0 },
    });
    const quarantined = (await transfers.quarantine({ status: "active" })).items[0]!;
    await expect(readFile(
      path.join(sourcePath, ...quarantined.quarantinedRelativePath.split("/")),
    )).resolves.toEqual(payload);
    expect(await transfers.receiptForPlan(plan.id)).toMatchObject({
      kind: "cross-volume-organization",
      status: "completed",
    });

    await service.restore(quarantined.id, "test-user", "RESTORE archive.dat");
    await worker.runOnce();
    await expect(readFile(sourceFile)).resolves.toEqual(payload);
    await expect(readFile(destinationFile)).resolves.toEqual(payload);
    expect(await transfers.quarantineItem(quarantined.id)).toMatchObject({ status: "restored" });
  });
});

class SimulatedVolumeIdentityProvider implements VolumeIdentityProvider {
  public identify(inspection: CanonicalPathInspection): Promise<FilesystemVolumeIdentity> {
    const volumeName = path.basename(inspection.canonicalPath);
    return Promise.resolve({
      kind: "filesystem-device",
      key: `simulated-volume:${volumeName}`,
      stability: "best-effort",
      deviceId: inspection.deviceId,
      ...(inspection.fileSystemTypeCode === undefined
        ? {}
        : { fileSystemTypeCode: inspection.fileSystemTypeCode }),
      mountPathAtEnrollment: inspection.mountPath,
    });
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
