import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  InventoryPage,
  InventoryRecord,
  InventoryRecordId,
  InventoryScanCheckpoint,
  InventoryScanId,
  InventoryScanPage,
  InventoryScanSession,
  InventoryScanStatus,
  InventorySummary,
  JobId,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";

interface ScanSessionRow {
  id: string;
  root_id: string;
  job_id: string;
  root_identity_key: string;
  status: InventoryScanStatus;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  records_observed: number;
  files_discovered: number;
  directories_visited: number;
  bytes_represented: number;
  skipped_entries: number;
  error_entries: number;
  checkpoint_json: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface InventoryRecordRow {
  id: string;
  scan_id: string;
  root_id: string;
  job_id: string;
  relative_path: string;
  name: string;
  extension: string | null;
  entry_type: InventoryRecord["entryType"];
  observation_status: InventoryRecord["observationStatus"];
  byte_length: number | null;
  created_at: string | null;
  modified_at: string | null;
  device_id: string | null;
  filesystem_record_id: string | null;
  hidden: number | null;
  system: number | null;
  read_only: number | null;
  issue_code: string | null;
  issue_message: string | null;
  observed_at: string;
}

export interface StartInventoryScanInput {
  readonly id: InventoryScanId;
  readonly rootId: LibraryRootId;
  readonly jobId: JobId;
  readonly rootIdentityKey: string;
  readonly startedAt: string;
}

export interface InventoryWriteBatch {
  readonly observations: readonly InventoryRecord[];
  /** Portable root-relative directory paths to add to the durable frontier. */
  readonly discoveredDirectories: readonly RootRelativePath[];
}

export interface InventoryBatchResult {
  readonly insertedObservationCount: number;
  readonly insertedDirectoryCount: number;
}

export interface InventoryListQuery {
  readonly scanId?: InventoryScanId;
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
  readonly entryType?: InventoryRecord["entryType"];
  readonly extension?: string;
}

export interface InventoryScanListQuery {
  readonly rootId?: LibraryRootId;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface InventoryCatalog {
  startOrLoadScan(input: StartInventoryScanInput): Promise<InventoryScanSession>;
  getScan(id: InventoryScanId): Promise<InventoryScanSession | undefined>;
  getScanByJob(jobId: JobId): Promise<InventoryScanSession | undefined>;
  resumeScan(id: InventoryScanId, updatedAt: string): Promise<InventoryScanSession>;
  claimNextDirectory(
    id: InventoryScanId,
    updatedAt: string,
  ): Promise<RootRelativePath | undefined>;
  writeBatch(
    id: InventoryScanId,
    batch: InventoryWriteBatch,
    updatedAt: string,
  ): Promise<InventoryBatchResult>;
  completeDirectory(
    id: InventoryScanId,
    relativePath: RootRelativePath,
    checkpoint: InventoryScanCheckpoint,
    updatedAt: string,
  ): Promise<InventoryScanSession>;
  saveCheckpoint(
    id: InventoryScanId,
    checkpoint: InventoryScanCheckpoint,
    updatedAt: string,
  ): Promise<InventoryScanSession>;
  setScanStatus(
    id: InventoryScanId,
    status: InventoryScanStatus,
    updatedAt: string,
    error?: { readonly code: string; readonly message: string },
  ): Promise<InventoryScanSession>;
  summary(rootId: LibraryRootId): Promise<InventorySummary>;
  listScans(query?: InventoryScanListQuery): Promise<InventoryScanPage>;
  list(rootId: LibraryRootId, query?: InventoryListQuery): Promise<InventoryPage>;
  get(recordId: InventoryRecordId): Promise<InventoryRecord | undefined>;
  hasObservedPath(
    rootId: LibraryRootId,
    scanId: InventoryScanId,
    relativePath: RootRelativePath,
  ): Promise<boolean>;
}

export interface SqliteInventoryCatalogOptions {
  readonly databasePath: string;
  readonly busyTimeoutMilliseconds?: number;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS inventory_scan_sessions (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  root_identity_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  records_observed INTEGER NOT NULL DEFAULT 0 CHECK (records_observed >= 0),
  files_discovered INTEGER NOT NULL DEFAULT 0 CHECK (files_discovered >= 0),
  directories_visited INTEGER NOT NULL DEFAULT 0 CHECK (directories_visited >= 0),
  bytes_represented INTEGER NOT NULL DEFAULT 0 CHECK (bytes_represented >= 0),
  skipped_entries INTEGER NOT NULL DEFAULT 0 CHECK (skipped_entries >= 0),
  error_entries INTEGER NOT NULL DEFAULT 0 CHECK (error_entries >= 0),
  checkpoint_json TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS inventory_scans_root_started
  ON inventory_scan_sessions(root_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS inventory_scans_status
  ON inventory_scan_sessions(status, updated_at);

CREATE TABLE IF NOT EXISTS inventory_records (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES inventory_scan_sessions(id),
  root_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  extension TEXT,
  entry_type TEXT NOT NULL,
  observation_status TEXT NOT NULL CHECK (observation_status IN ('observed', 'skipped', 'error')),
  byte_length INTEGER,
  created_at TEXT,
  modified_at TEXT,
  device_id TEXT,
  filesystem_record_id TEXT,
  hidden INTEGER CHECK (hidden IS NULL OR hidden IN (0, 1)),
  system INTEGER CHECK (system IS NULL OR system IN (0, 1)),
  read_only INTEGER CHECK (read_only IS NULL OR read_only IN (0, 1)),
  content_identity_status TEXT NOT NULL CHECK (content_identity_status = 'not-requested'),
  issue_code TEXT,
  issue_message TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (scan_id, relative_path, observation_status, issue_code)
);
CREATE INDEX IF NOT EXISTS inventory_records_root_scan_path
  ON inventory_records(root_id, scan_id, relative_path, id);
CREATE INDEX IF NOT EXISTS inventory_records_scan_type
  ON inventory_records(scan_id, entry_type, observation_status);
CREATE INDEX IF NOT EXISTS inventory_records_root_observed
  ON inventory_records(root_id, observed_at);

CREATE TABLE IF NOT EXISTS inventory_scan_frontier (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL REFERENCES inventory_scan_sessions(id),
  relative_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'completed')),
  updated_at TEXT NOT NULL,
  UNIQUE (scan_id, relative_path)
);
CREATE INDEX IF NOT EXISTS inventory_frontier_next
  ON inventory_scan_frontier(scan_id, state, ordinal);
`;

/** Separate SQLite catalog for inventory observations and scan work frontiers. */
export class SqliteInventoryCatalog implements InventoryCatalog {
  readonly #database: DatabaseSync;

  public constructor(options: SqliteInventoryCatalogOptions) {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }
    this.#database = new DatabaseSync(options.databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec(
      `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMilliseconds ?? 5_000))}`,
    );
    this.#database.exec(SCHEMA);
  }

  public close(): void {
    this.#database.close();
  }

  public async startOrLoadScan(
    input: StartInventoryScanInput,
  ): Promise<InventoryScanSession> {
    return this.#transaction(() => {
      const byJob = this.#getScanRowByJob(input.jobId);
      if (byJob !== undefined) {
        if (
          byJob.id !== input.id ||
          byJob.root_id !== input.rootId ||
          byJob.root_identity_key !== input.rootIdentityKey
        ) {
          throw new Error("The existing scan session does not match the job binding.");
        }
        return scanFromRow(byJob);
      }
      this.#database.prepare(`INSERT INTO inventory_scan_sessions (
        id, root_id, job_id, root_identity_key, status, started_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run(
        input.id,
        input.rootId,
        input.jobId,
        input.rootIdentityKey,
        input.startedAt,
        input.startedAt,
      );
      this.#database.prepare(`INSERT INTO inventory_scan_frontier (
        scan_id, relative_path, state, updated_at
      ) VALUES (?, '', 'pending', ?)`).run(input.id, input.startedAt);
      return scanFromRow(this.#requireScanRow(input.id));
    });
  }

  public async getScan(id: InventoryScanId): Promise<InventoryScanSession | undefined> {
    const row = this.#getScanRow(id);
    return row === undefined ? undefined : scanFromRow(row);
  }

  public async getScanByJob(jobId: JobId): Promise<InventoryScanSession | undefined> {
    const row = this.#getScanRowByJob(jobId);
    return row === undefined ? undefined : scanFromRow(row);
  }

  public async resumeScan(
    id: InventoryScanId,
    updatedAt: string,
  ): Promise<InventoryScanSession> {
    return this.#transaction(() => {
      const row = this.#requireScanRow(id);
      if (row.status === "completed" || row.status === "cancelled") {
        return scanFromRow(row);
      }
      this.#database.prepare(`UPDATE inventory_scan_frontier SET
        state = 'pending', updated_at = ?
        WHERE scan_id = ? AND state = 'processing'`).run(updatedAt, id);
      this.#database.prepare(`UPDATE inventory_scan_sessions SET
        status = 'running', completed_at = NULL, error_code = NULL,
        error_message = NULL, updated_at = ? WHERE id = ?`).run(updatedAt, id);
      return scanFromRow(this.#requireScanRow(id));
    });
  }

  public async claimNextDirectory(
    id: InventoryScanId,
    updatedAt: string,
  ): Promise<RootRelativePath | undefined> {
    return this.#transaction(() => {
      const row = this.#database.prepare(`SELECT ordinal, relative_path
        FROM inventory_scan_frontier
        WHERE scan_id = ? AND state = 'pending'
        ORDER BY ordinal ASC LIMIT 1`).get(id) as unknown as
        | { ordinal: number; relative_path: string }
        | undefined;
      if (row === undefined) return undefined;
      const result = this.#database.prepare(`UPDATE inventory_scan_frontier SET
        state = 'processing', updated_at = ?
        WHERE ordinal = ? AND state = 'pending'`).run(updatedAt, row.ordinal);
      if (Number(result.changes) !== 1) return undefined;
      return row.relative_path as RootRelativePath;
    });
  }

  public async writeBatch(
    id: InventoryScanId,
    batch: InventoryWriteBatch,
    updatedAt: string,
  ): Promise<InventoryBatchResult> {
    return this.#transaction(() => {
      this.#requireScanRow(id);
      const insertRecord = this.#database.prepare(`INSERT OR IGNORE INTO inventory_records (
        id, scan_id, root_id, job_id, relative_path, name, extension,
        entry_type, observation_status, byte_length, created_at, modified_at,
        device_id, filesystem_record_id, hidden, system, read_only,
        content_identity_status, issue_code, issue_message, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'not-requested', ?, ?, ?)`);
      let insertedObservationCount = 0;
      let filesDiscovered = 0;
      let bytesRepresented = 0;
      let skippedEntries = 0;
      let errorEntries = 0;
      for (const record of batch.observations) {
        if (record.scanId !== id) throw new Error("Inventory record scan ID mismatch.");
        const inserted = Number(insertRecord.run(
          record.id,
          record.scanId,
          record.rootId,
          record.jobId,
          record.relativePath,
          record.name,
          record.extension ?? null,
          record.entryType,
          record.observationStatus,
          record.byteLength ?? null,
          record.createdAt ?? null,
          record.modifiedAt ?? null,
          record.deviceId ?? null,
          record.filesystemRecordId ?? null,
          booleanToSql(record.attributes.hidden),
          booleanToSql(record.attributes.system),
          booleanToSql(record.attributes.readOnly),
          record.issue?.code ?? null,
          record.issue?.message ?? null,
          record.observedAt,
        ).changes);
        if (inserted === 0) continue;
        insertedObservationCount += 1;
        if (record.entryType === "file" && record.observationStatus === "observed") {
          filesDiscovered += 1;
          bytesRepresented += record.byteLength ?? 0;
        }
        if (record.observationStatus === "skipped") skippedEntries += 1;
        if (record.observationStatus === "error") errorEntries += 1;
      }

      const insertDirectory = this.#database.prepare(`INSERT OR IGNORE INTO inventory_scan_frontier (
        scan_id, relative_path, state, updated_at
      ) VALUES (?, ?, 'pending', ?)`);
      let insertedDirectoryCount = 0;
      for (const relativePath of batch.discoveredDirectories) {
        insertedDirectoryCount += Number(
          insertDirectory.run(id, relativePath, updatedAt).changes,
        );
      }

      if (insertedObservationCount > 0) {
        this.#database.prepare(`UPDATE inventory_scan_sessions SET
          records_observed = records_observed + ?,
          files_discovered = files_discovered + ?,
          bytes_represented = bytes_represented + ?,
          skipped_entries = skipped_entries + ?,
          error_entries = error_entries + ?,
          updated_at = ? WHERE id = ?`).run(
            insertedObservationCount,
            filesDiscovered,
            bytesRepresented,
            skippedEntries,
            errorEntries,
            updatedAt,
            id,
          );
      }
      return { insertedObservationCount, insertedDirectoryCount };
    });
  }

  public async completeDirectory(
    id: InventoryScanId,
    relativePath: RootRelativePath,
    checkpoint: InventoryScanCheckpoint,
    updatedAt: string,
  ): Promise<InventoryScanSession> {
    return this.#transaction(() => {
      const result = this.#database.prepare(`UPDATE inventory_scan_frontier SET
        state = 'completed', updated_at = ?
        WHERE scan_id = ? AND relative_path = ? AND state = 'processing'`).run(
          updatedAt,
          id,
          relativePath,
        );
      this.#database.prepare(`UPDATE inventory_scan_sessions SET
        directories_visited = directories_visited + ?, checkpoint_json = ?,
        updated_at = ? WHERE id = ?`).run(
          Number(result.changes) === 1 ? 1 : 0,
          JSON.stringify(checkpoint),
          updatedAt,
          id,
        );
      return scanFromRow(this.#requireScanRow(id));
    });
  }

  public async saveCheckpoint(
    id: InventoryScanId,
    checkpoint: InventoryScanCheckpoint,
    updatedAt: string,
  ): Promise<InventoryScanSession> {
    this.#database.prepare(`UPDATE inventory_scan_sessions SET
      checkpoint_json = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(checkpoint),
        updatedAt,
        id,
      );
    return scanFromRow(this.#requireScanRow(id));
  }

  public async setScanStatus(
    id: InventoryScanId,
    status: InventoryScanStatus,
    updatedAt: string,
    error?: { readonly code: string; readonly message: string },
  ): Promise<InventoryScanSession> {
    this.#database.prepare(`UPDATE inventory_scan_sessions SET
      status = ?, completed_at = ?, error_code = ?, error_message = ?,
      updated_at = ? WHERE id = ?`).run(
        status,
        status === "completed" ? updatedAt : null,
        error?.code ?? null,
        error?.message ?? null,
        updatedAt,
        id,
      );
    return scanFromRow(this.#requireScanRow(id));
  }

  public async summary(rootId: LibraryRootId): Promise<InventorySummary> {
    const row = this.#database.prepare(`SELECT * FROM inventory_scan_sessions
      WHERE root_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`).get(rootId) as
      unknown as ScanSessionRow | undefined;
    const count = this.#database.prepare(`SELECT COUNT(*) AS count
      FROM inventory_scan_sessions WHERE root_id = ?`).get(rootId) as unknown as {
        count: number;
      };
    return {
      rootId,
      ...(row === undefined ? {} : { latestScan: scanFromRow(row) }),
      retainedScanCount: Number(count.count),
    };
  }

  public async listScans(
    query: InventoryScanListQuery = {},
  ): Promise<InventoryScanPage> {
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const offset = decodeOffsetCursor(query.cursor);
    const rows = query.rootId === undefined
      ? this.#database.prepare(`SELECT * FROM inventory_scan_sessions
          ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(limit + 1, offset) as unknown as ScanSessionRow[]
      : this.#database.prepare(`SELECT * FROM inventory_scan_sessions
          WHERE root_id = ? ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(query.rootId, limit + 1, offset) as unknown as ScanSessionRow[];
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map(scanFromRow),
      ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + limit) } : {}),
    };
  }

  public async list(
    rootId: LibraryRootId,
    query: InventoryListQuery = {},
  ): Promise<InventoryPage> {
    const scanId = query.scanId ?? this.#latestScanId(rootId);
    if (scanId === undefined) return { items: [] };
    const limit = Math.max(1, Math.min(1_000, Math.trunc(query.limit ?? 100)));
    const cursor = decodeCursor(query.cursor);
    const conditions = ["root_id = ?", "scan_id = ?"];
    const values: Array<string | number | null> = [rootId, scanId];
    if (query.search !== undefined && query.search.trim().length > 0) {
      const search = `%${escapeLike(query.search.trim())}%`;
      conditions.push("(name LIKE ? ESCAPE '\\' COLLATE NOCASE OR relative_path LIKE ? ESCAPE '\\' COLLATE NOCASE)");
      values.push(search, search);
    }
    if (query.entryType !== undefined) {
      conditions.push("entry_type = ?");
      values.push(query.entryType);
    }
    if (query.extension !== undefined && query.extension.trim().length > 0) {
      conditions.push("LOWER(extension) = LOWER(?)");
      values.push(query.extension.trim().replace(/^\./u, ""));
    }
    if (cursor !== undefined) {
      conditions.push("(relative_path > ? OR (relative_path = ? AND id > ?))");
      values.push(cursor.relativePath, cursor.relativePath, cursor.id);
    }
    values.push(limit + 1);
    const rows = this.#database.prepare(`SELECT * FROM inventory_records
      WHERE ${conditions.join(" AND ")}
      ORDER BY relative_path ASC, id ASC LIMIT ?`).all(
        ...values,
      ) as unknown as InventoryRecordRow[];
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      scanId,
      items: visible.map(recordFromRow),
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeCursor(last.relative_path, last.id) }
        : {}),
    };
  }

  public async get(recordId: InventoryRecordId): Promise<InventoryRecord | undefined> {
    const row = this.#database.prepare(`SELECT * FROM inventory_records
      WHERE id = ?`).get(recordId) as unknown as InventoryRecordRow | undefined;
    return row === undefined ? undefined : recordFromRow(row);
  }

  public async hasObservedPath(
    rootId: LibraryRootId,
    scanId: InventoryScanId,
    relativePath: RootRelativePath,
  ): Promise<boolean> {
    const collation = process.platform === "win32" ? " COLLATE NOCASE" : "";
    const row = this.#database.prepare(`SELECT 1 AS present FROM inventory_records
      WHERE root_id = ? AND scan_id = ? AND relative_path = ?${collation}
      AND observation_status = 'observed' LIMIT 1`).get(
      rootId,
      scanId,
      relativePath,
    ) as unknown as { present: number } | undefined;
    return row !== undefined;
  }

  #latestScanId(rootId: LibraryRootId): InventoryScanId | undefined {
    const row = this.#database.prepare(`SELECT id FROM inventory_scan_sessions
      WHERE root_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`).get(rootId) as
      unknown as { id: string } | undefined;
    return row?.id as InventoryScanId | undefined;
  }

  #getScanRow(id: InventoryScanId): ScanSessionRow | undefined {
    return this.#database.prepare(`SELECT * FROM inventory_scan_sessions
      WHERE id = ?`).get(id) as unknown as ScanSessionRow | undefined;
  }

  #getScanRowByJob(jobId: JobId): ScanSessionRow | undefined {
    return this.#database.prepare(`SELECT * FROM inventory_scan_sessions
      WHERE job_id = ?`).get(jobId) as unknown as ScanSessionRow | undefined;
  }

  #requireScanRow(id: InventoryScanId): ScanSessionRow {
    const row = this.#getScanRow(id);
    if (row === undefined) throw new Error(`Inventory scan ${id} does not exist.`);
    return row;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function scanFromRow(row: ScanSessionRow): InventoryScanSession {
  return {
    id: row.id as InventoryScanId,
    rootId: row.root_id as LibraryRootId,
    jobId: row.job_id as JobId,
    rootIdentityKey: row.root_identity_key,
    status: row.status,
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at,
    counts: {
      recordsObserved: Number(row.records_observed),
      filesDiscovered: Number(row.files_discovered),
      directoriesVisited: Number(row.directories_visited),
      bytesRepresented: Number(row.bytes_represented),
      skippedEntries: Number(row.skipped_entries),
      errorEntries: Number(row.error_entries),
    },
    ...(row.checkpoint_json === null
      ? {}
      : { checkpoint: JSON.parse(row.checkpoint_json) as InventoryScanCheckpoint }),
    ...(row.error_code === null
      ? {}
      : {
          error: {
            code: row.error_code,
            message: row.error_message ?? "Inventory scan failed.",
          },
        }),
  };
}

function recordFromRow(row: InventoryRecordRow): InventoryRecord {
  return {
    id: row.id as InventoryRecordId,
    scanId: row.scan_id as InventoryScanId,
    rootId: row.root_id as LibraryRootId,
    jobId: row.job_id as JobId,
    relativePath: row.relative_path as RootRelativePath,
    name: row.name,
    ...(row.extension === null ? {} : { extension: row.extension }),
    entryType: row.entry_type,
    observationStatus: row.observation_status,
    ...(row.byte_length === null ? {} : { byteLength: Number(row.byte_length) }),
    ...(row.created_at === null ? {} : { createdAt: row.created_at }),
    ...(row.modified_at === null ? {} : { modifiedAt: row.modified_at }),
    ...(row.device_id === null ? {} : { deviceId: row.device_id }),
    ...(row.filesystem_record_id === null
      ? {}
      : { filesystemRecordId: row.filesystem_record_id }),
    attributes: {
      ...(row.hidden === null ? {} : { hidden: row.hidden === 1 }),
      ...(row.system === null ? {} : { system: row.system === 1 }),
      ...(row.read_only === null ? {} : { readOnly: row.read_only === 1 }),
    },
    contentIdentity: { status: "not-requested" },
    ...(row.issue_code === null
      ? {}
      : {
          issue: {
            code: row.issue_code,
            message: row.issue_message ?? "Inventory observation issue.",
          },
        }),
    observedAt: row.observed_at,
  };
}

function booleanToSql(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function encodeCursor(relativePath: string, id: string): string {
  return Buffer.from(JSON.stringify([relativePath, id]), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
): { readonly relativePath: string; readonly id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string"
    ) {
      throw new Error("invalid cursor shape");
    }
    return { relativePath: value[0], id: value[1] };
  } catch {
    throw new Error("The inventory cursor is invalid.");
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("The scan cursor is invalid.");
  }
  return value;
}

export function newInventoryScanId(jobId: JobId): InventoryScanId {
  return `inventory-scan-v1:${jobId}` as InventoryScanId;
}
