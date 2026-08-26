import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { JsonObject } from "../domain/index.js";
import type {
  DurableTransferItem,
  DurableTransferPlan,
  QuarantineItem,
  QuarantinePage,
  TransferAuditEvent,
  TransferItemPage,
  TransferItemStatus,
  TransferPlanKind,
  TransferPlanPage,
  TransferPlanStatus,
  TransferReceipt,
} from "./types.js";

const TRANSFER_SCHEMA_VERSION = 1;
const GENESIS_HASH = "0".repeat(64);

const TRANSFER_SCHEMA = `
CREATE TABLE transfer_plans (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ingest', 'cross-volume-organization', 'duplicate-consolidation')),
  source_root_id TEXT NOT NULL,
  source_root_identity_key TEXT NOT NULL,
  source_display_path TEXT NOT NULL,
  destination_root_id TEXT,
  destination_root_identity_key TEXT,
  target_directory TEXT,
  retire_source INTEGER NOT NULL CHECK (retire_source IN (0, 1)),
  preserve_source_folders INTEGER NOT NULL CHECK (preserve_source_folders IN (0, 1)),
  status TEXT NOT NULL,
  analysis_job_id TEXT,
  transfer_job_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX transfer_plans_listing ON transfer_plans(created_at DESC, id DESC);

CREATE TABLE transfer_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES transfer_plans(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_relative_path TEXT NOT NULL,
  original_source_path TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  destination_relative_path TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  source_modified_at TEXT,
  source_device_id TEXT,
  source_filesystem_record_id TEXT,
  algorithm TEXT CHECK (algorithm IS NULL OR algorithm = 'sha256'),
  digest_hex TEXT,
  category TEXT,
  mime_type TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  explanation TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  duplicate_matches_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  copied_bytes INTEGER NOT NULL DEFAULT 0 CHECK (copied_bytes >= 0),
  destination_verified_at TEXT,
  quarantine_item_id TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, source_relative_path)
);
CREATE INDEX transfer_items_page ON transfer_items(plan_id, ordinal, id);
CREATE INDEX transfer_items_status ON transfer_items(plan_id, status, ordinal);

CREATE TABLE transfer_directories (
  plan_id TEXT NOT NULL REFERENCES transfer_plans(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'scanning', 'completed')),
  PRIMARY KEY (plan_id, relative_path)
);
CREATE INDEX transfer_directories_work ON transfer_directories(plan_id, status, relative_path);

CREATE TABLE quarantine_items (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  root_identity_key TEXT NOT NULL,
  original_relative_path TEXT NOT NULL,
  quarantined_relative_path TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'sha256'),
  digest_hex TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('duplicate-consolidation', 'verified-source-retirement')),
  plan_id TEXT NOT NULL REFERENCES transfer_plans(id),
  transfer_item_id TEXT NOT NULL REFERENCES transfer_items(id),
  job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'restoring', 'restored', 'restore-blocked')),
  quarantined_at TEXT NOT NULL,
  restored_at TEXT,
  restore_job_id TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (transfer_item_id)
);
CREATE INDEX quarantine_listing ON quarantine_items(status, quarantined_at DESC, id DESC);

CREATE TABLE transfer_receipts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE REFERENCES transfer_plans(id),
  job_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE transfer_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL
);
`;

interface PlanRow {
  id: string;
  kind: TransferPlanKind;
  source_root_id: string;
  source_root_identity_key: string;
  source_display_path: string;
  destination_root_id: string | null;
  destination_root_identity_key: string | null;
  target_directory: string | null;
  retire_source: number;
  preserve_source_folders: number;
  status: TransferPlanStatus;
  analysis_job_id: string | null;
  transfer_job_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  approved_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ItemRow {
  id: string;
  plan_id: string;
  ordinal: number;
  source_relative_path: string;
  original_source_path: string;
  original_file_name: string;
  destination_relative_path: string | null;
  byte_length: number;
  source_modified_at: string | null;
  source_device_id: string | null;
  source_filesystem_record_id: string | null;
  algorithm: "sha256" | null;
  digest_hex: string | null;
  category: string | null;
  mime_type: string | null;
  confidence: number | null;
  explanation: string | null;
  metadata_json: string;
  duplicate_matches_json: string;
  status: TransferItemStatus;
  copied_bytes: number;
  destination_verified_at: string | null;
  quarantine_item_id: string | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: number | null;
  updated_at: string;
}

interface QuarantineRow {
  id: string;
  root_id: string;
  root_identity_key: string;
  original_relative_path: string;
  quarantined_relative_path: string;
  original_file_name: string;
  algorithm: "sha256";
  digest_hex: string;
  byte_length: number;
  reason: QuarantineItem["reason"];
  plan_id: string;
  transfer_item_id: string;
  job_id: string;
  status: QuarantineItem["status"];
  quarantined_at: string;
  restored_at: string | null;
  restore_job_id: string | null;
  error_code: string | null;
  error_message: string | null;
}

export class SqliteTransferStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string, busyTimeoutMilliseconds = 15_000) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA wal_autocheckpoint = 1000");
    this.#database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMilliseconds))}`);
    try {
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  public close(): void {
    this.#database.close();
  }

  public schemaVersion(): number {
    return Number(this.#database.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
  }

  public async createPlan(plan: Omit<DurableTransferPlan, "counts">): Promise<DurableTransferPlan> {
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO transfer_plans (
        id, kind, source_root_id, source_root_identity_key, source_display_path,
        destination_root_id, destination_root_identity_key, target_directory,
        retire_source, preserve_source_folders, status, analysis_job_id,
        transfer_job_id, created_by, created_at, updated_at, approved_by,
        approved_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          plan.id, plan.kind, plan.sourceRootId, plan.sourceRootIdentityKey,
          plan.sourceDisplayPath, plan.destinationRootId ?? null,
          plan.destinationRootIdentityKey ?? null, plan.targetDirectory ?? null,
          plan.retireSource ? 1 : 0, plan.preserveSourceFolders ? 1 : 0,
          plan.status, plan.analysisJobId ?? null, plan.transferJobId ?? null,
          plan.createdBy, plan.createdAt, plan.updatedAt, plan.approvedBy ?? null,
          plan.approvedAt ?? null, plan.error?.code ?? null, plan.error?.message ?? null,
        );
      this.#appendAudit("plan-created", plan.id, {
        kind: plan.kind,
        sourceRootId: plan.sourceRootId,
        ...(plan.destinationRootId === undefined ? {} : { destinationRootId: plan.destinationRootId }),
        retireSource: plan.retireSource,
      }, plan.createdAt);
    });
    return this.#requirePlan(plan.id);
  }

  public async plan(id: string): Promise<DurableTransferPlan | undefined> {
    const row = this.#database.prepare("SELECT * FROM transfer_plans WHERE id = ?")
      .get(id) as unknown as PlanRow | undefined;
    return row === undefined ? undefined : this.#planFromRow(row);
  }

  public async plans(input: {
    readonly kind?: TransferPlanKind;
    readonly status?: TransferPlanStatus;
    readonly limit?: number;
    readonly cursor?: string;
  } = {}): Promise<TransferPlanPage> {
    const limit = boundedLimit(input.limit, 50, 200);
    const offset = decodeOffset(input.cursor, "transfer-plans");
    const where: string[] = ["1 = 1"];
    const args: (string | number)[] = [];
    if (input.kind !== undefined) { where.push("kind = ?"); args.push(input.kind); }
    if (input.status !== undefined) { where.push("status = ?"); args.push(input.status); }
    const rows = this.#database.prepare(`SELECT * FROM transfer_plans
      WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit + 1, offset) as unknown as PlanRow[];
    return {
      items: rows.slice(0, limit).map((row) => this.#planFromRow(row)),
      ...(rows.length > limit ? { nextCursor: encodeOffset("transfer-plans", offset + limit) } : {}),
    };
  }

  public async setPlanState(
    id: string,
    status: TransferPlanStatus,
    updatedAt: string,
    input: {
      readonly analysisJobId?: string;
      readonly transferJobId?: string;
      readonly approvedBy?: string;
      readonly approvedAt?: string;
      readonly error?: { readonly code: string; readonly message: string };
    } = {},
  ): Promise<DurableTransferPlan> {
    this.#transaction(() => {
      const result = this.#database.prepare(`UPDATE transfer_plans SET status = ?,
        analysis_job_id = COALESCE(?, analysis_job_id),
        transfer_job_id = COALESCE(?, transfer_job_id),
        approved_by = COALESCE(?, approved_by), approved_at = COALESCE(?, approved_at),
        error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`).run(
          status, input.analysisJobId ?? null, input.transferJobId ?? null,
          input.approvedBy ?? null, input.approvedAt ?? null,
          input.error?.code ?? null, input.error?.message ?? null, updatedAt, id,
        );
      if (Number(result.changes) !== 1) throw new Error("The transfer plan does not exist.");
      this.#appendAudit("plan-status", id, {
        status,
        ...(input.analysisJobId === undefined ? {} : { analysisJobId: input.analysisJobId }),
        ...(input.transferJobId === undefined ? {} : { transferJobId: input.transferJobId }),
        ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
        ...(input.error === undefined ? {} : { error: input.error }),
      }, updatedAt);
    });
    return this.#requirePlan(id);
  }

  public async addDirectory(planId: string, relativePath: string): Promise<void> {
    this.#database.prepare(`INSERT OR IGNORE INTO transfer_directories (plan_id, relative_path, status)
      VALUES (?, ?, 'pending')`).run(planId, relativePath);
  }

  public async resetScanningDirectories(planId: string): Promise<void> {
    this.#database.prepare(`UPDATE transfer_directories SET status = 'pending'
      WHERE plan_id = ? AND status = 'scanning'`).run(planId);
  }

  public async claimDirectory(planId: string): Promise<string | undefined> {
    return this.#transaction(() => {
      const row = this.#database.prepare(`SELECT relative_path FROM transfer_directories
        WHERE plan_id = ? AND status = 'pending' ORDER BY relative_path LIMIT 1`)
        .get(planId) as unknown as { relative_path: string } | undefined;
      if (row === undefined) return undefined;
      this.#database.prepare(`UPDATE transfer_directories SET status = 'scanning'
        WHERE plan_id = ? AND relative_path = ? AND status = 'pending'`)
        .run(planId, row.relative_path);
      return row.relative_path;
    });
  }

  public async completeDirectory(planId: string, relativePath: string): Promise<void> {
    this.#database.prepare(`UPDATE transfer_directories SET status = 'completed'
      WHERE plan_id = ? AND relative_path = ?`).run(planId, relativePath);
  }

  public async addDiscoveredItems(
    planId: string,
    items: readonly Omit<DurableTransferItem, "planId" | "ordinal" | "metadata" | "duplicateMatches" | "status" | "copiedBytes" | "updatedAt">[],
    updatedAt: string,
  ): Promise<void> {
    this.#transaction(() => {
      const ordinalRow = this.#database.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS value
        FROM transfer_items WHERE plan_id = ?`).get(planId) as unknown as { value: number };
      let ordinal = Number(ordinalRow.value) + 1;
      const insert = this.#database.prepare(`INSERT OR IGNORE INTO transfer_items (
        id, plan_id, ordinal, source_relative_path, original_source_path,
        original_file_name, destination_relative_path, byte_length,
        source_modified_at, source_device_id, source_filesystem_record_id,
        algorithm, digest_hex, category, mime_type, confidence, explanation,
        metadata_json, duplicate_matches_json, status, copied_bytes,
        destination_verified_at, quarantine_item_id, error_code, error_message,
        error_retryable, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', 'discovered', 0, ?, ?, ?, ?, ?, ?)`);
      for (const item of items) {
        const result = insert.run(
          item.id, planId, ordinal, item.sourceRelativePath, item.originalSourcePath,
          item.originalFileName, item.destinationRelativePath ?? null, item.byteLength,
          item.sourceModifiedAt ?? null, item.sourceDeviceId ?? null,
          item.sourceFilesystemRecordId ?? null, item.algorithm ?? null,
          item.digestHex ?? null, item.category ?? null, item.mimeType ?? null,
          item.confidence ?? null, item.explanation ?? null,
          item.destinationVerifiedAt ?? null, item.quarantineItemId ?? null,
          item.error?.code ?? null, item.error?.message ?? null,
          item.error === undefined ? null : item.error.retryable ? 1 : 0, updatedAt,
        );
        if (Number(result.changes) === 1) ordinal += 1;
      }
    });
  }

  public async item(id: string): Promise<DurableTransferItem | undefined> {
    const row = this.#database.prepare("SELECT * FROM transfer_items WHERE id = ?")
      .get(id) as unknown as ItemRow | undefined;
    return row === undefined ? undefined : itemFromRow(row);
  }

  public async items(
    planId: string,
    input: { readonly status?: TransferItemStatus; readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<TransferItemPage> {
    const limit = boundedLimit(input.limit, 100, 500);
    const offset = decodeOffset(input.cursor, "transfer-items");
    const rows = input.status === undefined
      ? this.#database.prepare(`SELECT * FROM transfer_items WHERE plan_id = ?
          ORDER BY ordinal, id LIMIT ? OFFSET ?`).all(planId, limit + 1, offset)
      : this.#database.prepare(`SELECT * FROM transfer_items WHERE plan_id = ? AND status = ?
          ORDER BY ordinal, id LIMIT ? OFFSET ?`).all(planId, input.status, limit + 1, offset);
    const values = rows as unknown as ItemRow[];
    return {
      items: values.slice(0, limit).map(itemFromRow),
      ...(values.length > limit ? { nextCursor: encodeOffset("transfer-items", offset + limit) } : {}),
    };
  }

  public async workItems(
    planId: string,
    statuses: readonly TransferItemStatus[],
    afterOrdinal: number,
    limit: number,
  ): Promise<readonly DurableTransferItem[]> {
    if (statuses.length === 0) return [];
    const slots = statuses.map(() => "?").join(", ");
    const rows = this.#database.prepare(`SELECT * FROM transfer_items
      WHERE plan_id = ? AND status IN (${slots}) AND ordinal > ?
      ORDER BY ordinal, id LIMIT ?`).all(
        planId, ...statuses, afterOrdinal, boundedLimit(limit, 100, 500),
      ) as unknown as ItemRow[];
    return rows.map(itemFromRow);
  }

  public async setItemState(
    id: string,
    status: TransferItemStatus,
    updatedAt: string,
    patch: {
      readonly destinationRelativePath?: string;
      readonly algorithm?: "sha256";
      readonly digestHex?: string;
      readonly category?: string;
      readonly mimeType?: string;
      readonly confidence?: number;
      readonly explanation?: string;
      readonly metadata?: JsonObject;
      readonly duplicateMatches?: DurableTransferItem["duplicateMatches"];
      readonly copiedBytes?: number;
      readonly destinationVerifiedAt?: string;
      readonly quarantineItemId?: string;
      readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
    } = {},
  ): Promise<DurableTransferItem> {
    const result = this.#database.prepare(`UPDATE transfer_items SET status = ?,
      destination_relative_path = COALESCE(?, destination_relative_path),
      algorithm = COALESCE(?, algorithm), digest_hex = COALESCE(?, digest_hex),
      category = COALESCE(?, category), mime_type = COALESCE(?, mime_type),
      confidence = COALESCE(?, confidence), explanation = COALESCE(?, explanation),
      metadata_json = COALESCE(?, metadata_json),
      duplicate_matches_json = COALESCE(?, duplicate_matches_json),
      copied_bytes = COALESCE(?, copied_bytes),
      destination_verified_at = COALESCE(?, destination_verified_at),
      quarantine_item_id = COALESCE(?, quarantine_item_id),
      error_code = ?, error_message = ?, error_retryable = ?, updated_at = ?
      WHERE id = ?`).run(
        status, patch.destinationRelativePath ?? null, patch.algorithm ?? null,
        patch.digestHex ?? null, patch.category ?? null, patch.mimeType ?? null,
        patch.confidence ?? null, patch.explanation ?? null,
        patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
        patch.duplicateMatches === undefined ? null : JSON.stringify(patch.duplicateMatches),
        patch.copiedBytes ?? null, patch.destinationVerifiedAt ?? null,
        patch.quarantineItemId ?? null, patch.error?.code ?? null,
        patch.error?.message ?? null,
        patch.error === undefined ? null : patch.error.retryable ? 1 : 0,
        updatedAt, id,
      );
    if (Number(result.changes) !== 1) throw new Error("The transfer item does not exist.");
    const saved = await this.item(id);
    if (saved === undefined) throw new Error("The transfer item disappeared.");
    return saved;
  }

  public async resolveItem(
    id: string,
    destinationRelativePath: string,
    updatedAt: string,
  ): Promise<DurableTransferItem> {
    return this.setItemState(id, "ready", updatedAt, {
      destinationRelativePath,
      confidence: 1,
      explanation: "Destination confirmed by the user.",
    });
  }

  public async createQuarantine(item: QuarantineItem): Promise<QuarantineItem> {
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO quarantine_items (
        id, root_id, root_identity_key, original_relative_path,
        quarantined_relative_path, original_file_name, algorithm, digest_hex,
        byte_length, reason, plan_id, transfer_item_id, job_id, status,
        quarantined_at, restored_at, restore_job_id, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          item.id, item.rootId, item.rootIdentityKey, item.originalRelativePath,
          item.quarantinedRelativePath, item.originalFileName, item.algorithm,
          item.digestHex, item.byteLength, item.reason, item.planId,
          item.transferItemId, item.jobId, item.status, item.quarantinedAt,
          item.restoredAt ?? null, item.restoreJobId ?? null,
          item.error?.code ?? null, item.error?.message ?? null,
        );
      this.#database.prepare(`UPDATE transfer_items SET quarantine_item_id = ?,
        status = 'quarantined', updated_at = ? WHERE id = ?`)
        .run(item.id, item.quarantinedAt, item.transferItemId);
      this.#appendAudit("file-quarantined", item.id, {
        rootId: item.rootId,
        originalRelativePath: item.originalRelativePath,
        quarantinedRelativePath: item.quarantinedRelativePath,
        digestHex: item.digestHex,
        reason: item.reason,
        planId: item.planId,
        jobId: item.jobId,
      }, item.quarantinedAt);
    });
    const saved = await this.quarantineItem(item.id);
    if (saved === undefined) throw new Error("The quarantine item disappeared.");
    return saved;
  }

  public async quarantineItem(id: string): Promise<QuarantineItem | undefined> {
    const row = this.#database.prepare("SELECT * FROM quarantine_items WHERE id = ?")
      .get(id) as unknown as QuarantineRow | undefined;
    return row === undefined ? undefined : quarantineFromRow(row);
  }

  public async quarantineForTransferItem(transferItemId: string): Promise<QuarantineItem | undefined> {
    const row = this.#database.prepare("SELECT * FROM quarantine_items WHERE transfer_item_id = ?")
      .get(transferItemId) as unknown as QuarantineRow | undefined;
    return row === undefined ? undefined : quarantineFromRow(row);
  }

  public async quarantine(input: {
    readonly rootId?: string;
    readonly status?: QuarantineItem["status"];
    readonly search?: string;
    readonly limit?: number;
    readonly cursor?: string;
  } = {}): Promise<QuarantinePage> {
    const limit = boundedLimit(input.limit, 50, 200);
    const offset = decodeOffset(input.cursor, "quarantine");
    const where: string[] = ["1 = 1"];
    const args: (string | number)[] = [];
    if (input.rootId !== undefined) { where.push("root_id = ?"); args.push(input.rootId); }
    if (input.status !== undefined) { where.push("status = ?"); args.push(input.status); }
    if (input.search !== undefined && input.search.trim().length > 0) {
      where.push("(original_relative_path LIKE ? ESCAPE '\\' OR original_file_name LIKE ? ESCAPE '\\')");
      const value = `%${escapeLike(input.search.trim())}%`;
      args.push(value, value);
    }
    const rows = this.#database.prepare(`SELECT * FROM quarantine_items
      WHERE ${where.join(" AND ")} ORDER BY quarantined_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit + 1, offset) as unknown as QuarantineRow[];
    return {
      items: rows.slice(0, limit).map(quarantineFromRow),
      ...(rows.length > limit ? { nextCursor: encodeOffset("quarantine", offset + limit) } : {}),
    };
  }

  public async setQuarantineState(
    id: string,
    status: QuarantineItem["status"],
    updatedAt: string,
    patch: {
      readonly restoreJobId?: string;
      readonly restoredAt?: string;
      readonly error?: { readonly code: string; readonly message: string };
    } = {},
  ): Promise<QuarantineItem> {
    this.#transaction(() => {
      const result = this.#database.prepare(`UPDATE quarantine_items SET status = ?,
        restore_job_id = COALESCE(?, restore_job_id), restored_at = COALESCE(?, restored_at),
        error_code = ?, error_message = ? WHERE id = ?`).run(
          status, patch.restoreJobId ?? null, patch.restoredAt ?? null,
          patch.error?.code ?? null, patch.error?.message ?? null, id,
        );
      if (Number(result.changes) !== 1) throw new Error("The quarantine item does not exist.");
      this.#appendAudit(status === "restored" ? "file-restored" : "quarantine-status", id, {
        status,
        ...(patch.restoreJobId === undefined ? {} : { restoreJobId: patch.restoreJobId }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
      }, updatedAt);
    });
    const saved = await this.quarantineItem(id);
    if (saved === undefined) throw new Error("The quarantine item disappeared.");
    return saved;
  }

  public async saveReceipt(receipt: TransferReceipt): Promise<void> {
    this.#database.prepare(`INSERT OR IGNORE INTO transfer_receipts
      (id, plan_id, job_id, receipt_json, completed_at) VALUES (?, ?, ?, ?, ?)`)
      .run(receipt.id, receipt.planId, receipt.jobId, JSON.stringify(receipt), receipt.completedAt);
  }

  public async receiptForPlan(planId: string): Promise<TransferReceipt | undefined> {
    const row = this.#database.prepare("SELECT receipt_json FROM transfer_receipts WHERE plan_id = ?")
      .get(planId) as unknown as { receipt_json: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.receipt_json) as TransferReceipt;
  }

  public async quarantineCount(rootId?: string): Promise<number> {
    const row = rootId === undefined
      ? this.#database.prepare("SELECT COUNT(*) AS value FROM quarantine_items WHERE status = 'active'").get()
      : this.#database.prepare(`SELECT COUNT(*) AS value FROM quarantine_items
          WHERE status = 'active' AND root_id = ?`).get(rootId);
    return Number((row as unknown as { value: number }).value);
  }

  public async audit(limit = 100, afterSequence = 0): Promise<readonly TransferAuditEvent[]> {
    const rows = this.#database.prepare(`SELECT sequence, id, event, entity_id, details_json,
      previous_hash, event_hash, occurred_at FROM transfer_audit
      WHERE sequence > ? ORDER BY sequence LIMIT ?`).all(
        Math.max(0, Math.trunc(afterSequence)), boundedLimit(limit, 100, 500),
      ) as unknown as Array<{
        sequence: number; id: string; event: string; entity_id: string;
        details_json: string; previous_hash: string; event_hash: string; occurred_at: string;
      }>;
    return rows.map((row) => ({
      sequence: row.sequence, id: row.id, event: row.event, entityId: row.entity_id,
      details: parseObject(row.details_json), previousHash: row.previous_hash,
      hash: row.event_hash, occurredAt: row.occurred_at,
    }));
  }

  #planFromRow(row: PlanRow): DurableTransferPlan {
    const counts = this.#database.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'exact-duplicate' THEN 1 ELSE 0 END) AS exact_duplicates,
      SUM(CASE WHEN status = 'needs-review' THEN 1 ELSE 0 END) AS needs_review,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COALESCE(SUM(byte_length), 0) AS total_bytes,
      COALESCE(SUM(copied_bytes), 0) AS copied_bytes
      FROM transfer_items WHERE plan_id = ?`).get(row.id) as unknown as Record<string, number | null>;
    return {
      id: row.id, kind: row.kind, sourceRootId: row.source_root_id,
      sourceRootIdentityKey: row.source_root_identity_key,
      sourceDisplayPath: row.source_display_path,
      ...(row.destination_root_id === null ? {} : { destinationRootId: row.destination_root_id }),
      ...(row.destination_root_identity_key === null ? {} : { destinationRootIdentityKey: row.destination_root_identity_key }),
      ...(row.target_directory === null ? {} : { targetDirectory: row.target_directory }),
      retireSource: row.retire_source === 1,
      preserveSourceFolders: row.preserve_source_folders === 1,
      status: row.status,
      ...(row.analysis_job_id === null ? {} : { analysisJobId: row.analysis_job_id }),
      ...(row.transfer_job_id === null ? {} : { transferJobId: row.transfer_job_id }),
      counts: {
        total: Number(counts["total"] ?? 0), ready: Number(counts["ready"] ?? 0),
        exactDuplicates: Number(counts["exact_duplicates"] ?? 0),
        needsReview: Number(counts["needs_review"] ?? 0),
        completed: Number(counts["completed"] ?? 0),
        quarantined: Number(counts["quarantined"] ?? 0),
        failed: Number(counts["failed"] ?? 0),
        totalBytes: Number(counts["total_bytes"] ?? 0),
        copiedBytes: Number(counts["copied_bytes"] ?? 0),
      },
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.approved_by === null ? {} : { approvedBy: row.approved_by }),
      ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
      ...(row.error_code === null ? {} : { error: { code: row.error_code, message: row.error_message ?? "Transfer failed." } }),
    };
  }

  #requirePlan(id: string): DurableTransferPlan {
    const row = this.#database.prepare("SELECT * FROM transfer_plans WHERE id = ?")
      .get(id) as unknown as PlanRow | undefined;
    if (row === undefined) throw new Error("The transfer plan does not exist.");
    return this.#planFromRow(row);
  }

  #appendAudit(event: string, entityId: string, details: JsonObject, occurredAt: string): void {
    const prior = this.#database.prepare(`SELECT event_hash FROM transfer_audit
      ORDER BY sequence DESC LIMIT 1`).get() as unknown as { event_hash: string } | undefined;
    const previousHash = prior?.event_hash ?? GENESIS_HASH;
    const id = `transfer-audit-v2:${randomUUID()}`;
    const canonical = JSON.stringify({ id, event, entityId, details, previousHash, occurredAt });
    const hash = createHash("sha256").update(canonical).digest("hex");
    this.#database.prepare(`INSERT INTO transfer_audit
      (id, event, entity_id, details_json, previous_hash, event_hash, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        id, event, entityId, JSON.stringify(details), previousHash, hash, occurredAt,
      );
  }

  #migrate(): void {
    this.#database.exec(`CREATE TABLE IF NOT EXISTS transfer_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const current = Number((this.#database.prepare(`SELECT COALESCE(MAX(version), 0) AS version
      FROM transfer_schema_migrations`).get() as unknown as { version: number }).version);
    if (current >= TRANSFER_SCHEMA_VERSION) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (current < 1) {
        this.#database.exec(TRANSFER_SCHEMA);
        this.#database.prepare(`INSERT INTO transfer_schema_migrations (version, name, applied_at)
          VALUES (1, 'v2-durable-transfers-and-quarantine', ?)`).run(new Date().toISOString());
      }
      this.#database.exec(`PRAGMA user_version = ${TRANSFER_SCHEMA_VERSION}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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

function itemFromRow(row: ItemRow): DurableTransferItem {
  return {
    id: row.id, planId: row.plan_id, ordinal: Number(row.ordinal),
    sourceRelativePath: row.source_relative_path,
    originalSourcePath: row.original_source_path,
    originalFileName: row.original_file_name,
    ...(row.destination_relative_path === null ? {} : { destinationRelativePath: row.destination_relative_path }),
    byteLength: Number(row.byte_length),
    ...(row.source_modified_at === null ? {} : { sourceModifiedAt: row.source_modified_at }),
    ...(row.source_device_id === null ? {} : { sourceDeviceId: row.source_device_id }),
    ...(row.source_filesystem_record_id === null ? {} : { sourceFilesystemRecordId: row.source_filesystem_record_id }),
    ...(row.algorithm === null ? {} : { algorithm: row.algorithm }),
    ...(row.digest_hex === null ? {} : { digestHex: row.digest_hex }),
    ...(row.category === null ? {} : { category: row.category }),
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
    ...(row.explanation === null ? {} : { explanation: row.explanation }),
    metadata: parseObject(row.metadata_json),
    duplicateMatches: parseMatches(row.duplicate_matches_json),
    status: row.status, copiedBytes: Number(row.copied_bytes),
    ...(row.destination_verified_at === null ? {} : { destinationVerifiedAt: row.destination_verified_at }),
    ...(row.quarantine_item_id === null ? {} : { quarantineItemId: row.quarantine_item_id }),
    ...(row.error_code === null ? {} : {
      error: {
        code: row.error_code,
        message: row.error_message ?? "Transfer item failed.",
        retryable: row.error_retryable === 1,
      },
    }),
    updatedAt: row.updated_at,
  };
}

function quarantineFromRow(row: QuarantineRow): QuarantineItem {
  return {
    id: row.id, rootId: row.root_id, rootIdentityKey: row.root_identity_key,
    originalRelativePath: row.original_relative_path,
    quarantinedRelativePath: row.quarantined_relative_path,
    originalFileName: row.original_file_name, algorithm: row.algorithm,
    digestHex: row.digest_hex, byteLength: Number(row.byte_length),
    reason: row.reason, planId: row.plan_id, transferItemId: row.transfer_item_id,
    jobId: row.job_id, status: row.status, quarantinedAt: row.quarantined_at,
    ...(row.restored_at === null ? {} : { restoredAt: row.restored_at }),
    ...(row.restore_job_id === null ? {} : { restoreJobId: row.restore_job_id }),
    ...(row.error_code === null ? {} : { error: { code: row.error_code, message: row.error_message ?? "Restore failed." } }),
  };
}

function parseObject(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as JsonObject
    : {};
}

function parseMatches(value: string): DurableTransferItem["duplicateMatches"] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is { recordId: string; rootId: string; relativePath: string } =>
    typeof entry === "object" && entry !== null &&
    typeof (entry as Record<string, unknown>)["recordId"] === "string" &&
    typeof (entry as Record<string, unknown>)["rootId"] === "string" &&
    typeof (entry as Record<string, unknown>)["relativePath"] === "string");
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const parsed = Math.trunc(value ?? fallback);
  return Math.max(1, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

function encodeOffset(kind: string, offset: number): string {
  return Buffer.from(JSON.stringify({ kind, offset }), "utf8").toString("base64url");
}

function decodeOffset(value: string | undefined, kind: string): number {
  if (value === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed["kind"] !== kind || !Number.isSafeInteger(parsed["offset"]) || Number(parsed["offset"]) < 0) {
      throw new Error();
    }
    return Number(parsed["offset"]);
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
