import { createHash } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import * as path from "node:path";

import type {
  ApprovedLibraryRoot,
  InventoryEntryType,
  InventoryRecord,
  InventoryRecordId,
  InventoryScanCheckpoint,
  InventoryScanId,
  InventoryScanSession,
  JobId,
  JsonObject,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";
import type {
  InventoryCatalog,
  InventoryWriteBatch,
} from "../catalog/index.js";
import {
  newInventoryScanId,
} from "../catalog/index.js";
import type {
  JobDefinition,
  JobExecutionContext,
  JobHandler,
  PersistentJobRecord,
  StructuredJobResult,
} from "../jobs/index.js";
import { JobHandlerFailure } from "../jobs/index.js";
import type {
  InventoryDirectoryHandle,
  InventoryMetadataFilesystem,
} from "./metadata-filesystem.js";
import { NodeInventoryMetadataFilesystem } from "./metadata-filesystem.js";
import {
  InventoryRootGuard,
  InventoryRootValidationError,
} from "./inventory-root-guard.js";

export interface InventoryScanPayload extends JsonObject {
  readonly rootId: string;
  readonly rootIdentityKey: string;
}

export interface InventoryScanHandlerOptions {
  readonly batchSize?: number;
  readonly directoryBufferSize?: number;
  readonly filesystem?: InventoryMetadataFilesystem;
  readonly clock?: () => Date;
  /** Test/telemetry hook invoked only after a durable batch checkpoint. */
  readonly afterBatch?: (
    information: {
      readonly scanId: InventoryScanId;
      readonly batchObservationCount: number;
      readonly currentRelativePath: string;
    },
  ) => Promise<void>;
}

export const INVENTORY_SCAN_JOB_DEFINITION: JobDefinition = {
  kind: "inventory.scan",
  recoveryMode: "resume-from-checkpoint",
  validatePayload(payload): void {
    const keys = Object.keys(payload).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "rootId" ||
      keys[1] !== "rootIdentityKey" ||
      typeof payload["rootId"] !== "string" ||
      payload["rootId"].length === 0 ||
      typeof payload["rootIdentityKey"] !== "string" ||
      payload["rootIdentityKey"].length === 0
    ) {
      throw new Error(
        "inventory.scan payload must contain non-empty rootId and rootIdentityKey strings.",
      );
    }
  },
};

/** Incremental metadata-only scan backed by a durable SQLite directory frontier. */
export class InventoryScanJobHandler implements JobHandler {
  public readonly kind = "inventory.scan" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #rootGuard: InventoryRootGuard;
  readonly #catalog: InventoryCatalog;
  readonly #filesystem: InventoryMetadataFilesystem;
  readonly #batchSize: number;
  readonly #directoryBufferSize: number;
  readonly #clock: () => Date;
  readonly #afterBatch: InventoryScanHandlerOptions["afterBatch"];

  public constructor(
    rootGuard: InventoryRootGuard,
    catalog: InventoryCatalog,
    options: InventoryScanHandlerOptions = {},
  ) {
    this.#rootGuard = rootGuard;
    this.#catalog = catalog;
    this.#filesystem = options.filesystem ?? new NodeInventoryMetadataFilesystem();
    this.#batchSize = positiveInteger(options.batchSize ?? 256, "batchSize");
    this.#directoryBufferSize = positiveInteger(
      options.directoryBufferSize ?? 64,
      "directoryBufferSize",
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#afterBatch = options.afterBatch;
  }

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    INVENTORY_SCAN_JOB_DEFINITION.validatePayload(job.payload);
    const rootId = job.payload["rootId"] as LibraryRootId;
    const rootIdentityKey = job.payload["rootIdentityKey"] as string;
    const scanId = newInventoryScanId(job.id);
    const existing = await this.#catalog.getScanByJob(job.id);
    if (existing?.status === "completed") return resultFor(existing, this.#now());

    let session: InventoryScanSession | undefined = existing;
    try {
      session ??= await this.#catalog.startOrLoadScan({
        id: scanId,
        rootId,
        jobId: job.id,
        rootIdentityKey,
        startedAt: this.#now(),
      });
      const root = await this.#rootGuard.validateForScan(rootId, rootIdentityKey);
      if (session.status === "completed") return resultFor(session, this.#now());
      session = await this.#catalog.resumeScan(scanId, this.#now());
      return await this.scan(root, session, context);
    } catch (error) {
      if (isCooperativeControl(error)) throw error;
      if (session !== undefined) {
        const issue = errorDetails(error);
        await this.#catalog.setScanStatus(scanId, "failed", this.#now(), issue);
      }
      if (error instanceof JobHandlerFailure) throw error;
      if (error instanceof InventoryRootValidationError) {
        throw new JobHandlerFailure(error.code, error.message, false, {
          rootId,
        });
      }
      throw error;
    }
  }

  private async scan(
    root: ApprovedLibraryRoot,
    initialSession: InventoryScanSession,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    let session = initialSession;
    while (true) {
      await this.checkApprovalAndControl(root, session, context);
      const relativeDirectory = await this.#catalog.claimNextDirectory(
        session.id,
        this.#now(),
      );
      if (relativeDirectory === undefined) {
        const checkpoint = checkpointFor(session, "");
        session = await this.#catalog.saveCheckpoint(
          session.id,
          checkpoint,
          this.#now(),
        );
        await context.saveCheckpoint(checkpoint);
        await context.reportProgress(progressFor(session, "", this.#now()));
        session = await this.#catalog.setScanStatus(
          session.id,
          "completed",
          this.#now(),
        );
        return resultFor(session, this.#now());
      }

      let directoryPath: string;
      try {
        directoryPath = await this.#rootGuard.resolveDirectory(
          root,
          relativeDirectory,
        );
      } catch (error) {
        if (
          relativeDirectory === "" ||
          (error instanceof InventoryRootValidationError &&
            error.code !== "ROOT_BOUNDARY_DENIED")
        ) {
          throw error;
        }
        const observation = issueRecord(
          root,
          session.id,
          session.jobId,
          displayRelative(relativeDirectory),
          "directory",
          "skipped",
          "DIRECTORY_BOUNDARY_DENIED",
          error instanceof Error ? error.message : "Directory boundary validation failed.",
          this.#now(),
        );
        await this.#catalog.writeBatch(
          session.id,
          { observations: [observation], discoveredDirectories: [] },
          this.#now(),
        );
        session = await this.finishDirectory(
          session,
          relativeDirectory,
          context,
        );
        continue;
      }

      session = await this.scanDirectory(
        root,
        session,
        relativeDirectory,
        directoryPath,
        context,
      );
    }
  }

  private async scanDirectory(
    root: ApprovedLibraryRoot,
    initialSession: InventoryScanSession,
    relativeDirectory: RootRelativePath,
    directoryPath: string,
    context: JobExecutionContext,
  ): Promise<InventoryScanSession> {
    let session = initialSession;
    let handle: InventoryDirectoryHandle | undefined;
    try {
      handle = await this.#filesystem.openDirectory(
        directoryPath,
        this.#directoryBufferSize,
      );
      let observations: InventoryRecord[] = [];
      let directories: RootRelativePath[] = [];
      for await (const entry of handle) {
        const produced = await this.observeEntry(
          root,
          session.id,
          session.jobId,
          relativeDirectory,
          directoryPath,
          entry,
        );
        observations.push(produced.observation);
        if (produced.directory !== undefined) directories.push(produced.directory);

        if (observations.length >= this.#batchSize) {
          session = await this.flushBatch(
            root,
            session,
            relativeDirectory,
            { observations, discoveredDirectories: directories },
            context,
          );
          observations = [];
          directories = [];
        }
      }
      if (observations.length > 0 || directories.length > 0) {
        session = await this.flushBatch(
          root,
          session,
          relativeDirectory,
          { observations, discoveredDirectories: directories },
          context,
        );
      }
    } catch (error) {
      if (isCooperativeControl(error) || error instanceof InventoryRootValidationError) {
        throw error;
      }
      if (!isExpectedDirectoryReadError(error)) throw error;
      const relative = displayRelative(relativeDirectory);
      const status = isNodeError(error, "ENOENT") ? "skipped" : "error";
      const observation = issueRecord(
        root,
        session.id,
        session.jobId,
        relative,
        "directory",
        status,
        isNodeError(error, "ENOENT") ? "DIRECTORY_VANISHED" : "DIRECTORY_INACCESSIBLE",
        error instanceof Error ? error.message : "Directory enumeration failed.",
        this.#now(),
      );
      await this.#catalog.writeBatch(
        session.id,
        { observations: [observation], discoveredDirectories: [] },
        this.#now(),
      );
    } finally {
      if (handle !== undefined) await closeDirectory(handle);
    }

    return this.finishDirectory(session, relativeDirectory, context);
  }

  private async observeEntry(
    root: ApprovedLibraryRoot,
    scanId: InventoryScanId,
    jobId: JobId,
    relativeDirectory: RootRelativePath,
    directoryPath: string,
    entry: Dirent,
  ): Promise<{
    readonly observation: InventoryRecord;
    readonly directory?: RootRelativePath;
  }> {
    const now = this.#now();
    if (!safeEntryName(entry.name)) {
      return {
        observation: issueRecord(
          root,
          scanId,
          jobId,
          portableJoin(relativeDirectory, encodeUnsafeName(entry.name)),
          "unknown",
          "skipped",
          "UNSAFE_ENTRY_NAME",
          "The directory entry name could not be represented safely.",
          now,
        ),
      };
    }
    const relativePath = portableJoin(relativeDirectory, entry.name);
    if (isIgnored(root, relativePath)) {
      return {
        observation: issueRecord(
          root,
          scanId,
          jobId,
          relativePath,
          entry.isDirectory() ? "directory" : "unknown",
          "skipped",
          "POLICY_IGNORED_PATH",
          "The path is excluded by the enrolled root policy.",
          now,
        ),
      };
    }

    const absolutePath = path.join(directoryPath, entry.name);
    let stats: BigIntStats;
    try {
      stats = await this.#filesystem.lstat(absolutePath);
    } catch (error) {
      const vanished = isNodeError(error, "ENOENT");
      return {
        observation: issueRecord(
          root,
          scanId,
          jobId,
          relativePath,
          "unknown",
          vanished ? "skipped" : "error",
          vanished ? "ENTRY_VANISHED" : "ENTRY_METADATA_INACCESSIBLE",
          error instanceof Error ? error.message : "Entry metadata could not be read.",
          now,
        ),
      };
    }

    if (stats.isSymbolicLink()) {
      return {
        observation: issueRecord(
          root,
          scanId,
          jobId,
          relativePath,
          "symbolic-link",
          "skipped",
          "REPARSE_POINT_FORBIDDEN",
          "Symbolic links and junctions are recorded but never followed.",
          now,
          stats,
        ),
      };
    }
    if (
      root.policy.stayOnFileSystem &&
      stats.dev.toString() !== root.identity.volume.deviceId
    ) {
      return {
        observation: issueRecord(
          root,
          scanId,
          jobId,
          relativePath,
          entryType(stats),
          "skipped",
          "FILESYSTEM_BOUNDARY_CROSSING",
          "The entry is on a different filesystem device.",
          now,
          stats,
        ),
      };
    }

    const type = entryType(stats);
    if (type === "directory") {
      try {
        await this.#rootGuard.resolveDirectory(root, relativePath);
      } catch (error) {
        if (
          error instanceof InventoryRootValidationError &&
          error.code !== "ROOT_BOUNDARY_DENIED"
        ) {
          throw error;
        }
        return {
          observation: issueRecord(
            root,
            scanId,
            jobId,
            relativePath,
            type,
            "skipped",
            "DIRECTORY_BOUNDARY_DENIED",
            error instanceof Error ? error.message : "Directory boundary validation failed.",
            now,
            stats,
          ),
        };
      }
    }

    return {
      observation: observedRecord(root, scanId, jobId, relativePath, type, stats, now),
      ...(type === "directory" ? { directory: relativePath } : {}),
    };
  }

  private async flushBatch(
    root: ApprovedLibraryRoot,
    session: InventoryScanSession,
    currentDirectory: RootRelativePath,
    batch: InventoryWriteBatch,
    context: JobExecutionContext,
  ): Promise<InventoryScanSession> {
    await this.#catalog.writeBatch(session.id, batch, this.#now());
    const current = await this.#catalog.getScan(session.id);
    if (current === undefined) throw new Error(`Scan ${session.id} disappeared.`);
    const checkpoint = checkpointFor(current, displayRelative(currentDirectory));
    const checkpointed = await this.#catalog.saveCheckpoint(
      current.id,
      checkpoint,
      this.#now(),
    );
    await context.saveCheckpoint(checkpoint);
    await context.reportProgress(
      progressFor(checkpointed, displayRelative(currentDirectory), this.#now()),
    );
    if (this.#afterBatch !== undefined) {
      await this.#afterBatch({
        scanId: session.id,
        batchObservationCount: batch.observations.length,
        currentRelativePath: displayRelative(currentDirectory),
      });
    }
    await this.checkApprovalAndControl(root, checkpointed, context);
    return checkpointed;
  }

  private async finishDirectory(
    session: InventoryScanSession,
    relativeDirectory: RootRelativePath,
    context: JobExecutionContext,
  ): Promise<InventoryScanSession> {
    const current = await this.#catalog.getScan(session.id);
    if (current === undefined) throw new Error(`Scan ${session.id} disappeared.`);
    const provisional = checkpointFor(current, displayRelative(relativeDirectory));
    const completed = await this.#catalog.completeDirectory(
      session.id,
      relativeDirectory,
      provisional,
      this.#now(),
    );
    const checkpoint = checkpointFor(completed, displayRelative(relativeDirectory));
    const saved = await this.#catalog.saveCheckpoint(
      completed.id,
      checkpoint,
      this.#now(),
    );
    await context.saveCheckpoint(checkpoint);
    await context.reportProgress(
      progressFor(saved, displayRelative(relativeDirectory), this.#now()),
    );
    return saved;
  }

  private async checkApprovalAndControl(
    root: ApprovedLibraryRoot,
    session: InventoryScanSession,
    context: JobExecutionContext,
  ): Promise<void> {
    try {
      await this.#rootGuard.loadApprovedLibrary(root.id, root.identity.key);
    } catch (error) {
      const issue = errorDetails(error);
      await this.#catalog.setScanStatus(session.id, "failed", this.#now(), issue);
      if (error instanceof InventoryRootValidationError) {
        throw new JobHandlerFailure(error.code, error.message, false, {
          rootId: root.id,
          scanId: session.id,
        });
      }
      throw error;
    }

    const signal = await context.controlSignal();
    if (signal === "continue") return;
    const status = signal === "pause" ? "paused" : "cancelled";
    const checkpoint = checkpointFor(session, session.checkpoint?.currentRelativePath ?? "");
    await this.#catalog.saveCheckpoint(session.id, checkpoint, this.#now());
    await this.#catalog.setScanStatus(session.id, status, this.#now());
    await context.saveCheckpoint(checkpoint);
    await context.throwIfControlRequested();
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function observedRecord(
  root: ApprovedLibraryRoot,
  scanId: InventoryScanId,
  jobId: JobId,
  relativePath: RootRelativePath,
  type: InventoryEntryType,
  stats: BigIntStats,
  observedAt: string,
): InventoryRecord {
  const name = portableBasename(relativePath);
  return {
    id: recordId(scanId, relativePath, "observed", ""),
    scanId,
    rootId: root.id,
    jobId,
    relativePath,
    name,
    ...extensionOf(name),
    entryType: type,
    observationStatus: "observed",
    ...(type === "file" ? { byteLength: safeSize(stats.size) } : {}),
    ...timestamps(stats),
    deviceId: stats.dev.toString(),
    filesystemRecordId: stats.ino.toString(),
    attributes: attributes(name, stats.mode),
    contentIdentity: { status: "not-requested" },
    observedAt,
  };
}

function issueRecord(
  root: ApprovedLibraryRoot,
  scanId: InventoryScanId,
  jobId: JobId,
  relativePath: RootRelativePath,
  type: InventoryEntryType,
  status: "skipped" | "error",
  code: string,
  message: string,
  observedAt: string,
  stats?: BigIntStats,
): InventoryRecord {
  const name = portableBasename(relativePath);
  return {
    id: recordId(scanId, relativePath, status, code),
    scanId,
    rootId: root.id,
    jobId,
    relativePath,
    name,
    ...extensionOf(name),
    entryType: type,
    observationStatus: status,
    ...(stats === undefined || type !== "file"
      ? {}
      : { byteLength: safeSize(stats.size) }),
    ...(stats === undefined ? {} : timestamps(stats)),
    ...(stats === undefined
      ? {}
      : {
          deviceId: stats.dev.toString(),
          filesystemRecordId: stats.ino.toString(),
        }),
    attributes: stats === undefined ? attributes(name) : attributes(name, stats.mode),
    contentIdentity: { status: "not-requested" },
    issue: { code, message },
    observedAt,
  };
}

function checkpointFor(
  session: InventoryScanSession,
  currentRelativePath: string,
): InventoryScanCheckpoint {
  return {
    scanId: session.id,
    currentRelativePath,
    ...session.counts,
  };
}

function progressFor(
  session: InventoryScanSession,
  currentRelativePath: string,
  updatedAt: string,
): import("../jobs/index.js").JobProgress {
  return {
    phase: "inventory",
    completedUnits: session.counts.recordsObserved,
    unit: "items",
    message: `Inventorying ${currentRelativePath || "."}`,
    metrics: {
      filesDiscovered: session.counts.filesDiscovered,
      directoriesVisited: session.counts.directoriesVisited,
      bytesRepresented: session.counts.bytesRepresented,
      skippedEntries: session.counts.skippedEntries,
      errorEntries: session.counts.errorEntries,
      currentRelativeLocation: currentRelativePath || ".",
    },
    updatedAt,
  };
}

function resultFor(
  session: InventoryScanSession,
  completedAt: string,
): StructuredJobResult {
  return {
    summary: {
      scanId: session.id,
      rootId: session.rootId,
      ...session.counts,
    },
    artifacts: [{ kind: "catalog-query", id: session.id }],
    completedAt,
  };
}

function recordId(
  scanId: InventoryScanId,
  relativePath: RootRelativePath,
  status: string,
  issueCode: string,
): InventoryRecordId {
  const digest = createHash("sha256")
    .update("local-librarian-inventory-record-v1\0", "utf8")
    .update(scanId, "utf8")
    .update("\0", "utf8")
    .update(relativePath, "utf8")
    .update("\0", "utf8")
    .update(status, "utf8")
    .update("\0", "utf8")
    .update(issueCode, "utf8")
    .digest("hex");
  return `inventory-record-v1:${digest}` as InventoryRecordId;
}

function entryType(stats: BigIntStats): InventoryEntryType {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symbolic-link";
  return "other";
}

function timestamps(stats: BigIntStats): {
  readonly createdAt?: string;
  readonly modifiedAt?: string;
} {
  const birth = Number(stats.birthtimeMs);
  const modified = Number(stats.mtimeMs);
  return {
    ...(Number.isFinite(birth) && birth > 0
      ? { createdAt: new Date(birth).toISOString() }
      : {}),
    ...(Number.isFinite(modified) && modified > 0
      ? { modifiedAt: new Date(modified).toISOString() }
      : {}),
  };
}

function attributes(name: string, mode?: bigint): {
  readonly hidden: boolean;
  readonly readOnly?: boolean;
} {
  return {
    hidden: name.startsWith("."),
    ...(mode === undefined ? {} : { readOnly: (mode & 0o222n) === 0n }),
  };
}

function safeSize(size: bigint): number {
  const value = Number(size);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("A file size could not be represented safely in the inventory schema.");
  }
  return value;
}

function extensionOf(name: string): { readonly extension?: string } {
  const extension = path.extname(name);
  return extension.length <= 1 ? {} : { extension: extension.slice(1) };
}

function safeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("\0") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    (process.platform !== "win32" || !name.includes(":"))
  );
}

function encodeUnsafeName(name: string): string {
  return `unsafe-entry-${Buffer.from(name, "utf8").toString("base64url")}`;
}

function portableJoin(
  parent: RootRelativePath,
  name: string,
): RootRelativePath {
  return (parent === "" ? name : `${parent}/${name}`) as RootRelativePath;
}

function portableBasename(relativePath: RootRelativePath): string {
  if (relativePath === "." || relativePath === "") return ".";
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

function displayRelative(relativePath: RootRelativePath): RootRelativePath {
  return (relativePath === "" ? "." : relativePath) as RootRelativePath;
}

function isIgnored(
  root: ApprovedLibraryRoot,
  relativePath: RootRelativePath,
): boolean {
  const candidate = normalizePolicyPath(relativePath);
  return root.policy.ignoredPaths.some((ignored) => {
    const normalized = normalizePolicyPath(ignored);
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function normalizePolicyPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function closeDirectory(handle: InventoryDirectoryHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if (!isNodeError(error, "ERR_DIR_CLOSED")) throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isExpectedDirectoryReadError(error: unknown): boolean {
  return ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ESTALE"].some(
    (code) => isNodeError(error, code),
  );
}

function isCooperativeControl(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "JobPauseRequested" || error.name === "JobCancellationRequested")
  );
}

function errorDetails(error: unknown): { readonly code: string; readonly message: string } {
  return {
    code:
      error instanceof InventoryRootValidationError
        ? error.code
        : error instanceof JobHandlerFailure
          ? error.code
          : "INVENTORY_SCAN_FAILED",
    message: error instanceof Error ? error.message : "Inventory scan failed.",
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
