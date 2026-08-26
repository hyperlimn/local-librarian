import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { JsonObject } from "../domain/index.js";
import {
  DEFAULT_RESOURCE_SETTINGS,
  type AnalysisStageName,
  type AnalysisStageState,
  type AnalysisStatus,
  type ContentHashObservation,
  type DuplicateGroupMember,
  type DuplicateGroupPage,
  type DuplicateGroupQuery,
  type DuplicateGroupSummary,
  type DuplicateMemberPage,
  type DurableStageStatus,
  type EnrichedInventoryItem,
  type EnrichedInventoryPage,
  type EnrichedInventoryQuery,
  type FileRelationship,
  type FileUnderstanding,
  type HashTask,
  type IntelligenceSummary,
  type NeedsReviewItem,
  type NeedsReviewPage,
  type NeedsReviewQuery,
  type PersistedAnalysisResult,
  type PersistedReconciliation,
  type PersistedReconciliationDelta,
  type ReconciliationDeltaKind,
  type ReconciliationDeltaPage,
  type ReconciliationStatus,
  type ResourceSettings,
  type SemanticGroup,
  type SemanticGroupKind,
} from "./types.js";

const CURRENT_SCHEMA_VERSION = 2;

const INTELLIGENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_identities (
  id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL,
  digest_hex TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  verified_at TEXT NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (algorithm, digest_hex, byte_length)
);

CREATE TABLE IF NOT EXISTS file_hashes (
  record_id TEXT PRIMARY KEY REFERENCES inventory_records(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL REFERENCES inventory_scan_sessions(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  content_id TEXT NOT NULL REFERENCES content_identities(id),
  algorithm TEXT NOT NULL CHECK (algorithm = 'sha256'),
  digest_hex TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  observed_modified_at TEXT,
  observed_device_id TEXT,
  observed_filesystem_record_id TEXT,
  hashed_at TEXT NOT NULL,
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'reused')),
  reused_from_record_id TEXT
);
CREATE INDEX IF NOT EXISTS file_hashes_digest
  ON file_hashes(algorithm, digest_hex, byte_length, scan_id);
CREATE INDEX IF NOT EXISTS file_hashes_reuse_identity
  ON file_hashes(root_id, observed_device_id, observed_filesystem_record_id, byte_length, observed_modified_at);
CREATE INDEX IF NOT EXISTS file_hashes_reuse_path
  ON file_hashes(root_id, relative_path, byte_length, observed_modified_at);

CREATE TABLE IF NOT EXISTS analysis_stages (
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL REFERENCES inventory_scan_sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not-started', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  job_id TEXT,
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
  total INTEGER CHECK (total IS NULL OR total >= 0),
  details_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (scan_id, stage)
);
CREATE INDEX IF NOT EXISTS analysis_stages_root_updated
  ON analysis_stages(root_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL REFERENCES inventory_scan_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('candidate', 'exact')),
  group_key TEXT NOT NULL,
  copy_count INTEGER NOT NULL CHECK (copy_count >= 2),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  reclaimable_bytes INTEGER NOT NULL CHECK (reclaimable_bytes >= 0),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('candidate', 'partially-verified', 'verified')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scan_id, kind, group_key)
);
CREATE INDEX IF NOT EXISTS duplicate_groups_listing
  ON duplicate_groups(root_id, kind, reclaimable_bytes DESC, id DESC);

CREATE TABLE IF NOT EXISTS duplicate_group_members (
  group_id TEXT NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES inventory_records(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT,
  modified_at TEXT,
  hash_state TEXT NOT NULL CHECK (hash_state IN ('not-hashed', 'verified', 'reused')),
  decision TEXT NOT NULL DEFAULT 'undecided' CHECK (decision IN ('undecided', 'keep', 'consolidate', 'keep-all')),
  PRIMARY KEY (group_id, record_id)
);
CREATE INDEX IF NOT EXISTS duplicate_members_record
  ON duplicate_group_members(record_id, group_id);
CREATE INDEX IF NOT EXISTS duplicate_members_group_path
  ON duplicate_group_members(group_id, relative_path, record_id);

CREATE TABLE IF NOT EXISTS analyzer_results (
  record_id TEXT NOT NULL REFERENCES inventory_records(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  analyzer_id TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  observation_signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unavailable', 'failed')),
  facts_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  analyzed_at TEXT NOT NULL,
  PRIMARY KEY (record_id, analyzer_id, analyzer_version, observation_signature)
);
CREATE INDEX IF NOT EXISTS analyzer_results_scan_status
  ON analyzer_results(scan_id, status, analyzer_id);
CREATE INDEX IF NOT EXISTS analyzer_results_reuse
  ON analyzer_results(root_id, analyzer_id, analyzer_version, observation_signature, analyzed_at DESC);

CREATE TABLE IF NOT EXISTS file_understanding (
  record_id TEXT PRIMARY KEY REFERENCES inventory_records(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  mime_type TEXT,
  category TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  classification_layer TEXT NOT NULL CHECK (classification_layer IN ('deterministic', 'context', 'local-model')),
  explanation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  uncertainty TEXT NOT NULL CHECK (uncertainty IN ('confident', 'needs-review')),
  analysis_state TEXT NOT NULL CHECK (analysis_state IN ('pending', 'analyzed', 'partial', 'failed')),
  capture_at TEXT,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  metadata_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_understanding_search
  ON file_understanding(scan_id, category, mime_type, analysis_state, relative_path);
CREATE INDEX IF NOT EXISTS file_understanding_capture
  ON file_understanding(scan_id, capture_at);

CREATE TABLE IF NOT EXISTS semantic_groups (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'album', 'media-pair', 'media-event')),
  display_name TEXT NOT NULL,
  relative_root TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  provenance TEXT NOT NULL CHECK (provenance IN ('deterministic', 'local-model', 'user')),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS semantic_groups_scan_kind
  ON semantic_groups(scan_id, kind, relative_root);

CREATE TABLE IF NOT EXISTS semantic_group_members (
  group_id TEXT NOT NULL REFERENCES semantic_groups(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES inventory_records(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (group_id, record_id)
);
CREATE INDEX IF NOT EXISTS semantic_members_record
  ON semantic_group_members(record_id, group_id);

CREATE TABLE IF NOT EXISTS file_relationships (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL REFERENCES inventory_records(id) ON DELETE CASCADE,
  target_record_id TEXT NOT NULL REFERENCES inventory_records(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  provenance TEXT NOT NULL CHECK (provenance IN ('deterministic', 'local-model', 'user')),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scan_id, source_record_id, target_record_id, kind)
);
CREATE INDEX IF NOT EXISTS relationships_source
  ON file_relationships(source_record_id, kind);
CREATE INDEX IF NOT EXISTS relationships_target
  ON file_relationships(target_record_id, kind);

CREATE TABLE IF NOT EXISTS needs_review (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  record_id TEXT,
  group_id TEXT,
  reason TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (scan_id, reason, record_id, group_id)
);
CREATE INDEX IF NOT EXISTS needs_review_listing
  ON needs_review(root_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS classification_rules (
  extension TEXT PRIMARY KEY COLLATE NOCASE,
  category TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'system')),
  use_count INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS librarian_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  baseline_scan_id TEXT NOT NULL REFERENCES inventory_scan_sessions(id),
  comparison_scan_id TEXT NOT NULL REFERENCES inventory_scan_sessions(id),
  job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  phase TEXT NOT NULL CHECK (phase IN ('missing', 'added', 'changed', 'complete')),
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
  added_count INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  changed_count INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (root_id, baseline_scan_id, comparison_scan_id)
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_root_created
  ON reconciliation_runs(root_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS reconciliation_deltas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'missing', 'metadata-changed')),
  changed_fields_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  UNIQUE (reconciliation_id, kind, relative_path)
);
CREATE INDEX IF NOT EXISTS reconciliation_deltas_page
  ON reconciliation_deltas(reconciliation_id, kind, relative_path, id);
CREATE INDEX IF NOT EXISTS reconciliation_deltas_cursor
  ON reconciliation_deltas(reconciliation_id, id);
CREATE INDEX IF NOT EXISTS reconciliation_deltas_kind_cursor
  ON reconciliation_deltas(reconciliation_id, kind, id);

CREATE INDEX IF NOT EXISTS inventory_records_duplicate_candidates
  ON inventory_records(scan_id, observation_status, entry_type, byte_length, relative_path);
CREATE INDEX IF NOT EXISTS inventory_records_reconciliation
  ON inventory_records(root_id, scan_id, observation_status, relative_path);
`;

interface StageRow {
  root_id: string;
  scan_id: string;
  stage: AnalysisStageName;
  status: DurableStageStatus;
  job_id: string | null;
  processed: number;
  total: number | null;
  details_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface HashRow {
  record_id: string;
  root_id: string;
  scan_id: string;
  relative_path: string;
  algorithm: "sha256";
  digest_hex: string;
  byte_length: number;
  observed_modified_at: string | null;
  observed_device_id: string | null;
  observed_filesystem_record_id: string | null;
  hashed_at: string;
  verification_state: "verified" | "reused";
  reused_from_record_id: string | null;
}

interface HashTaskRow {
  id: string;
  root_id: string;
  scan_id: string;
  relative_path: string;
  name: string;
  extension: string | null;
  byte_length: number;
  modified_at: string | null;
  device_id: string | null;
  filesystem_record_id: string | null;
}

interface DuplicateGroupRow {
  id: string;
  root_id: string;
  scan_id: string;
  kind: "candidate" | "exact";
  group_key: string;
  copy_count: number;
  byte_length: number;
  total_bytes: number;
  reclaimable_bytes: number;
  verification_state: "candidate" | "partially-verified" | "verified";
  keeper_count?: number;
  created_at: string;
  updated_at: string;
}

interface ReviewRow {
  id: string;
  root_id: string;
  scan_id: string;
  record_id: string | null;
  group_id: string | null;
  reason: NeedsReviewItem["reason"];
  title: string;
  description: string;
  evidence_json: string;
  status: NeedsReviewItem["status"];
  resolution_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface AnalyzerResultRow {
  record_id: string;
  root_id: string;
  scan_id: string;
  analyzer_id: string;
  analyzer_version: string;
  observation_signature: string;
  status: PersistedAnalysisResult["status"];
  facts_json: string;
  warnings_json: string;
  error_code: string | null;
  error_message: string | null;
  analyzed_at: string;
}

interface UnderstandingRow {
  record_id: string;
  root_id: string;
  scan_id: string;
  relative_path: string;
  parent_path: string;
  mime_type: string | null;
  category: string;
  confidence: number;
  classification_layer: FileUnderstanding["classificationLayer"];
  explanation: string;
  evidence_json: string;
  uncertainty: FileUnderstanding["uncertainty"];
  analysis_state: FileUnderstanding["analysisState"];
  capture_at: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  metadata_json: string;
  updated_at: string;
}

interface SemanticGroupRow {
  id: string;
  root_id: string;
  scan_id: string;
  kind: SemanticGroupKind;
  display_name: string;
  relative_root: string | null;
  confidence: number;
  provenance: SemanticGroup["provenance"];
  evidence_json: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

interface EnrichedRow {
  id: string;
  root_id: string;
  scan_id: string;
  relative_path: string;
  name: string;
  extension: string | null;
  byte_length: number | null;
  created_at: string | null;
  modified_at: string | null;
  verification_state: "verified" | "reused" | null;
  mime_type: string | null;
  category: string | null;
  capture_at: string | null;
  duration_seconds: number | null;
  analysis_state: FileUnderstanding["analysisState"] | null;
  needs_review: number;
  duplicate_state: EnrichedInventoryItem["duplicateState"];
}

interface ReconciliationFactRow {
  readonly relative_path: string;
  readonly [key: string]: string | number | null;
}

interface ReconciliationRow {
  id: string;
  root_id: string;
  baseline_scan_id: string;
  comparison_scan_id: string;
  job_id: string | null;
  status: ReconciliationStatus;
  phase: PersistedReconciliation["phase"];
  processed: number;
  added_count: number;
  missing_count: number;
  changed_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface SqliteIntelligenceStoreOptions {
  readonly databasePath: string;
  readonly busyTimeoutMilliseconds?: number;
}

export interface CandidateSizeGroup {
  readonly byteLength: number;
  readonly copyCount: number;
}

export interface ExactHashGroup {
  readonly digestHex: string;
  readonly byteLength: number;
  readonly copyCount: number;
}

export interface ReconciliationWorkItem {
  readonly relativePath: string;
  readonly before?: JsonObject;
  readonly after?: JsonObject;
  readonly changedFields: readonly string[];
}

export interface OrganizationPlanningEvidence {
  readonly recordId: string;
  readonly category?: string;
  readonly captureAt?: string;
  readonly uncertainty?: "confident" | "needs-review";
  readonly explanation?: string;
  readonly semanticGroups: readonly { readonly id: string; readonly kind: SemanticGroupKind; readonly displayName: string }[];
}

export interface ExactContentMatch {
  readonly recordId: string;
  readonly rootId: string;
  readonly relativePath: string;
}

export class SqliteIntelligenceStore {
  readonly #database: DatabaseSync;

  public constructor(options: SqliteIntelligenceStoreOptions) {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }
    this.#database = new DatabaseSync(options.databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA wal_autocheckpoint = 1000");
    this.#database.exec(
      `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMilliseconds ?? 15_000))}`,
    );
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

  public async setStage(input: {
    readonly rootId: string;
    readonly scanId: string;
    readonly stage: AnalysisStageName;
    readonly status: DurableStageStatus;
    readonly jobId?: string;
    readonly processed?: number;
    readonly total?: number;
    readonly details?: JsonObject;
    readonly error?: { readonly code: string; readonly message: string };
    readonly updatedAt: string;
  }): Promise<AnalysisStageState> {
    const terminal = ["completed", "failed", "cancelled"].includes(input.status);
    this.#database.prepare(`INSERT INTO analysis_stages (
      root_id, scan_id, stage, status, job_id, processed, total, details_json,
      error_code, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scan_id, stage) DO UPDATE SET
      status = excluded.status,
      job_id = COALESCE(excluded.job_id, analysis_stages.job_id),
      processed = excluded.processed,
      total = COALESCE(excluded.total, analysis_stages.total),
      details_json = excluded.details_json,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at`).run(
        input.rootId,
        input.scanId,
        input.stage,
        input.status,
        input.jobId ?? null,
        input.processed ?? 0,
        input.total ?? null,
        JSON.stringify(input.details ?? {}),
        input.error?.code ?? null,
        input.error?.message ?? null,
        input.updatedAt,
        input.updatedAt,
        terminal ? input.updatedAt : null,
      );
    return stageFromRow(this.#requireStage(input.scanId, input.stage));
  }

  public async stages(rootId: string, scanId?: string): Promise<readonly AnalysisStageState[]> {
    const rows = scanId === undefined
      ? this.#database.prepare(`SELECT * FROM analysis_stages
          WHERE root_id = ? ORDER BY updated_at DESC, stage`).all(rootId)
      : this.#database.prepare(`SELECT * FROM analysis_stages
          WHERE root_id = ? AND scan_id = ? ORDER BY stage`).all(rootId, scanId);
    return (rows as unknown as StageRow[]).map(stageFromRow);
  }

  public async analysisStatus(rootId: string, scanId?: string): Promise<AnalysisStatus> {
    const effectiveScanId = scanId ?? this.#latestCompletedScanId(rootId);
    if (effectiveScanId === undefined) {
      return { rootId, stages: [], totals: emptyAnalysisTotals() };
    }
    const row = this.#database.prepare(`SELECT
      (SELECT COUNT(*) FROM inventory_records WHERE scan_id = ? AND entry_type = 'file' AND observation_status = 'observed') AS files,
      (SELECT COUNT(*) FROM file_understanding WHERE scan_id = ? AND analysis_state IN ('analyzed', 'partial')) AS analyzed,
      (SELECT COUNT(*) FROM file_hashes WHERE scan_id = ? AND verification_state = 'verified') AS hashes_verified,
      (SELECT COUNT(*) FROM file_hashes WHERE scan_id = ? AND verification_state = 'reused') AS hashes_reused,
      (SELECT COUNT(*) FROM duplicate_groups WHERE scan_id = ? AND kind = 'candidate') AS candidates,
      (SELECT COUNT(*) FROM duplicate_groups WHERE scan_id = ? AND kind = 'exact') AS exacts,
      (SELECT COUNT(*) FROM needs_review WHERE scan_id = ? AND status = 'open') AS needs_review,
      (SELECT COUNT(*) FROM semantic_groups WHERE scan_id = ?) AS semantic_groups`).get(
        effectiveScanId,
        effectiveScanId,
        effectiveScanId,
        effectiveScanId,
        effectiveScanId,
        effectiveScanId,
        effectiveScanId,
        effectiveScanId,
      ) as unknown as Record<string, number>;
    return {
      rootId,
      scanId: effectiveScanId,
      stages: await this.stages(rootId, effectiveScanId),
      totals: {
        files: Number(row["files"] ?? 0),
        analyzed: Number(row["analyzed"] ?? 0),
        hashesVerified: Number(row["hashes_verified"] ?? 0),
        hashesReused: Number(row["hashes_reused"] ?? 0),
        candidateDuplicateGroups: Number(row["candidates"] ?? 0),
        exactDuplicateGroups: Number(row["exacts"] ?? 0),
        needsReview: Number(row["needs_review"] ?? 0),
        semanticGroups: Number(row["semantic_groups"] ?? 0),
      },
    };
  }

  public async settings(): Promise<ResourceSettings> {
    const row = this.#database.prepare("SELECT value_json FROM librarian_settings WHERE key = 'resources'")
      .get() as unknown as { value_json: string } | undefined;
    if (row === undefined) return DEFAULT_RESOURCE_SETTINGS;
    return validateResourceSettings(parseJson(row.value_json));
  }

  public async saveSettings(settings: ResourceSettings, updatedAt: string): Promise<ResourceSettings> {
    const validated = validateResourceSettings(settings);
    this.#database.prepare(`INSERT INTO librarian_settings (key, value_json, updated_at)
      VALUES ('resources', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(validated), updatedAt);
    return validated;
  }

  public async summary(rootId?: string): Promise<IntelligenceSummary> {
    const rootClause = rootId === undefined ? "" : " AND root_id = ?";
    const args = rootId === undefined ? [] : [rootId];
    const scalar = (sql: string): number => Number(
      (this.#database.prepare(sql).get(...args) as unknown as { value: number }).value,
    );
    const filesAnalyzed = scalar(`SELECT COUNT(*) AS value FROM file_understanding
      WHERE analysis_state IN ('analyzed', 'partial')${rootClause}`);
    const totalFiles = rootId === undefined
      ? scalar(`SELECT COUNT(*) AS value FROM inventory_records r
          WHERE r.entry_type = 'file' AND r.observation_status = 'observed'
          AND r.scan_id = (SELECT s.id FROM inventory_scan_sessions s
            WHERE s.root_id = r.root_id AND s.status = 'completed'
            ORDER BY s.started_at DESC, s.id DESC LIMIT 1)`)
      : Number((this.#database.prepare(`SELECT COUNT(*) AS value FROM inventory_records
          WHERE root_id = ? AND scan_id = ? AND entry_type = 'file' AND observation_status = 'observed'`)
        .get(rootId, this.#latestCompletedScanId(rootId) ?? "") as unknown as { value: number }).value);
    return {
      filesAnalyzed,
      filesAwaitingAnalysis: Math.max(0, totalFiles - filesAnalyzed),
      candidateDuplicateGroups: scalar(`SELECT COUNT(*) AS value FROM duplicate_groups WHERE kind = 'candidate'${rootClause}`),
      exactDuplicateGroups: scalar(`SELECT COUNT(*) AS value FROM duplicate_groups WHERE kind = 'exact'${rootClause}`),
      reclaimableDuplicateBytes: scalar(`SELECT COALESCE(SUM(reclaimable_bytes), 0) AS value FROM duplicate_groups WHERE kind = 'exact'${rootClause}`),
      needsReview: scalar(`SELECT COUNT(*) AS value FROM needs_review WHERE status = 'open'${rootClause}`),
      quarantineCount: 0,
    };
  }

  public latestCompletedScanId(rootId: string): string | undefined {
    return this.#latestCompletedScanId(rootId);
  }

  public async countHashTasks(
    scanId: string,
    scope: "duplicate-candidates" | "all",
  ): Promise<number> {
    const membership = scope === "duplicate-candidates"
      ? `AND EXISTS (
          SELECT 1 FROM duplicate_group_members m
          JOIN duplicate_groups g ON g.id = m.group_id
          WHERE m.record_id = r.id AND g.scan_id = r.scan_id AND g.kind = 'candidate'
        )`
      : "";
    const row = this.#database.prepare(`SELECT COUNT(*) AS count
      FROM inventory_records r
      WHERE r.scan_id = ? AND r.entry_type = 'file' AND r.observation_status = 'observed'
      AND r.byte_length IS NOT NULL ${membership}`)
      .get(scanId) as unknown as { count: number };
    return Number(row.count);
  }

  public async hashTaskTotals(
    scanId: string,
    scope: "duplicate-candidates" | "all",
  ): Promise<{ readonly files: number; readonly bytes: number }> {
    const membership = scope === "duplicate-candidates"
      ? `AND EXISTS (
          SELECT 1 FROM duplicate_group_members m
          JOIN duplicate_groups g ON g.id = m.group_id
          WHERE m.record_id = r.id AND g.scan_id = r.scan_id AND g.kind = 'candidate'
        )`
      : "";
    const row = this.#database.prepare(`SELECT COUNT(*) AS files,
      COALESCE(SUM(r.byte_length), 0) AS bytes FROM inventory_records r
      WHERE r.scan_id = ? AND r.entry_type = 'file' AND r.observation_status = 'observed'
        AND r.byte_length IS NOT NULL ${membership}`).get(scanId) as unknown as {
          files: number;
          bytes: number;
        };
    return { files: Number(row.files), bytes: Number(row.bytes) };
  }

  public async hashTasks(
    scanId: string,
    scope: "duplicate-candidates" | "all",
    limit: number,
    afterRelativePath?: string,
    afterRecordId?: string,
  ): Promise<readonly HashTask[]> {
    const bounded = boundedLimit(limit, 100, 500);
    const membership = scope === "duplicate-candidates"
      ? `AND EXISTS (
          SELECT 1 FROM duplicate_group_members m
          JOIN duplicate_groups g ON g.id = m.group_id
          WHERE m.record_id = r.id AND g.scan_id = r.scan_id AND g.kind = 'candidate'
        )`
      : "";
    const cursor = afterRelativePath === undefined
      ? ""
      : "AND (r.relative_path > ? OR (r.relative_path = ? AND r.id > ?))";
    const args: (string | number)[] = [scanId];
    if (afterRelativePath !== undefined) {
      args.push(afterRelativePath, afterRelativePath, afterRecordId ?? "");
    }
    args.push(bounded);
    const rows = this.#database.prepare(`SELECT
      r.id, r.root_id, r.scan_id, r.relative_path, r.name, r.extension,
      r.byte_length, r.modified_at, r.device_id, r.filesystem_record_id
      FROM inventory_records r
      WHERE r.scan_id = ? AND r.entry_type = 'file' AND r.observation_status = 'observed'
        AND r.byte_length IS NOT NULL ${membership} ${cursor}
      ORDER BY r.relative_path ASC, r.id ASC LIMIT ?`).all(...args) as unknown as HashTaskRow[];
    return rows.map(hashTaskFromRow);
  }

  public async hashForRecord(recordId: string): Promise<ContentHashObservation | undefined> {
    const row = this.#database.prepare("SELECT * FROM file_hashes WHERE record_id = ?")
      .get(recordId) as unknown as HashRow | undefined;
    return row === undefined ? undefined : hashFromRow(row);
  }

  public async exactContentMatches(
    digestHex: string,
    byteLength: number,
    limit = 100,
  ): Promise<readonly ExactContentMatch[]> {
    if (!/^[a-f0-9]{64}$/u.test(digestHex) || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("A valid SHA-256 digest and non-negative byte length are required.");
    }
    const rows = this.#database.prepare(`SELECT h.record_id, h.root_id, h.relative_path
      FROM file_hashes h
      JOIN inventory_records r ON r.id = h.record_id
      WHERE h.digest_hex = ? AND h.byte_length = ?
        AND r.observation_status = 'observed' AND r.entry_type = 'file'
        AND r.scan_id = (SELECT s.id FROM inventory_scan_sessions s
          WHERE s.root_id = r.root_id AND s.status = 'completed'
          ORDER BY s.started_at DESC, s.id DESC LIMIT 1)
      ORDER BY h.root_id, h.relative_path, h.record_id LIMIT ?`).all(
        digestHex,
        byteLength,
        boundedLimit(limit, 100, 500),
      ) as unknown as Array<{ record_id: string; root_id: string; relative_path: string }>;
    return rows.map((row) => ({
      recordId: row.record_id,
      rootId: row.root_id,
      relativePath: row.relative_path,
    }));
  }

  public async reusableHash(task: HashTask): Promise<ContentHashObservation | undefined> {
    if (task.modifiedAt === undefined) return undefined;
    let row: HashRow | undefined;
    if (task.deviceId !== undefined && task.filesystemRecordId !== undefined) {
      row = this.#database.prepare(`SELECT * FROM file_hashes
        WHERE root_id = ? AND algorithm = 'sha256' AND byte_length = ?
          AND observed_modified_at = ? AND observed_device_id = ?
          AND observed_filesystem_record_id = ? AND record_id <> ?
        ORDER BY hashed_at DESC LIMIT 1`).get(
          task.rootId,
          task.byteLength,
          task.modifiedAt,
          task.deviceId,
          task.filesystemRecordId,
          task.recordId,
        ) as unknown as HashRow | undefined;
    }
    row ??= this.#database.prepare(`SELECT * FROM file_hashes
      WHERE root_id = ? AND relative_path = ? AND algorithm = 'sha256'
        AND byte_length = ? AND observed_modified_at = ? AND record_id <> ?
      ORDER BY hashed_at DESC LIMIT 1`).get(
        task.rootId,
        task.relativePath,
        task.byteLength,
        task.modifiedAt,
        task.recordId,
      ) as unknown as HashRow | undefined;
    return row === undefined ? undefined : hashFromRow(row);
  }

  public async saveHash(
    task: HashTask,
    digestHex: string,
    hashedAt: string,
    verificationState: "verified" | "reused",
    reusedFromRecordId?: string,
  ): Promise<ContentHashObservation> {
    if (!/^[0-9a-f]{64}$/u.test(digestHex)) {
      throw new Error("A SHA-256 digest must be 64 lowercase hexadecimal characters.");
    }
    const contentId = `sha256:${digestHex}`;
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO content_identities (
        id, algorithm, digest_hex, byte_length, verified_at, format_version
      ) VALUES (?, 'sha256', ?, ?, ?, 1)
      ON CONFLICT(algorithm, digest_hex, byte_length) DO UPDATE SET
        verified_at = MAX(content_identities.verified_at, excluded.verified_at)`).run(
          contentId,
          digestHex,
          task.byteLength,
          hashedAt,
        );
      this.#database.prepare(`INSERT INTO file_hashes (
        record_id, root_id, scan_id, relative_path, content_id, algorithm,
        digest_hex, byte_length, observed_modified_at, observed_device_id,
        observed_filesystem_record_id, hashed_at, verification_state, reused_from_record_id
      ) VALUES (?, ?, ?, ?, ?, 'sha256', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content_id = excluded.content_id,
        digest_hex = excluded.digest_hex,
        byte_length = excluded.byte_length,
        observed_modified_at = excluded.observed_modified_at,
        observed_device_id = excluded.observed_device_id,
        observed_filesystem_record_id = excluded.observed_filesystem_record_id,
        hashed_at = excluded.hashed_at,
        verification_state = excluded.verification_state,
        reused_from_record_id = excluded.reused_from_record_id`).run(
          task.recordId,
          task.rootId,
          task.scanId,
          task.relativePath,
          contentId,
          digestHex,
          task.byteLength,
          task.modifiedAt ?? null,
          task.deviceId ?? null,
          task.filesystemRecordId ?? null,
          hashedAt,
          verificationState,
          reusedFromRecordId ?? null,
        );
      this.#database.prepare(`UPDATE duplicate_group_members SET hash_state = ?
        WHERE record_id = ?`).run(verificationState, task.recordId);
      this.#database.prepare(`UPDATE duplicate_groups SET
        verification_state = CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM duplicate_group_members m
            WHERE m.group_id = duplicate_groups.id AND m.hash_state = 'not-hashed'
          ) THEN 'verified'
          WHEN EXISTS (
            SELECT 1 FROM duplicate_group_members m
            WHERE m.group_id = duplicate_groups.id AND m.hash_state <> 'not-hashed'
          ) THEN 'partially-verified'
          ELSE 'candidate'
        END,
        updated_at = ?
        WHERE id IN (SELECT group_id FROM duplicate_group_members WHERE record_id = ?)`)
        .run(hashedAt, task.recordId);
    });
    const saved = await this.hashForRecord(task.recordId);
    if (saved === undefined) throw new Error("The saved content hash disappeared.");
    return saved;
  }

  public async candidateSizeGroups(
    scanId: string,
    afterByteLength = -1,
    limit = 250,
  ): Promise<readonly CandidateSizeGroup[]> {
    const rows = this.#database.prepare(`SELECT byte_length, COUNT(*) AS copy_count
      FROM inventory_records
      WHERE scan_id = ? AND observation_status = 'observed' AND entry_type = 'file'
        AND byte_length IS NOT NULL AND byte_length > ?
      GROUP BY byte_length HAVING COUNT(*) > 1
      ORDER BY byte_length ASC LIMIT ?`).all(
        scanId,
        afterByteLength,
        boundedLimit(limit, 250, 1_000),
      ) as unknown as { byte_length: number; copy_count: number }[];
    return rows.map((row) => ({ byteLength: row.byte_length, copyCount: row.copy_count }));
  }

  public async exactHashGroups(
    scanId: string,
    afterDigest = "",
    afterByteLength = -1,
    limit = 250,
  ): Promise<readonly ExactHashGroup[]> {
    const rows = this.#database.prepare(`SELECT digest_hex, byte_length, COUNT(*) AS copy_count
      FROM file_hashes
      WHERE scan_id = ?
        AND (digest_hex > ? OR (digest_hex = ? AND byte_length > ?))
      GROUP BY digest_hex, byte_length HAVING COUNT(*) > 1
      ORDER BY digest_hex ASC, byte_length ASC LIMIT ?`).all(
        scanId,
        afterDigest,
        afterDigest,
        afterByteLength,
        boundedLimit(limit, 250, 1_000),
      ) as unknown as { digest_hex: string; byte_length: number; copy_count: number }[];
    return rows.map((row) => ({
      digestHex: row.digest_hex,
      byteLength: row.byte_length,
      copyCount: row.copy_count,
    }));
  }

  public async clearDuplicateGroups(scanId: string, kind: "candidate" | "exact"): Promise<void> {
    this.#database.prepare("DELETE FROM duplicate_groups WHERE scan_id = ? AND kind = ?")
      .run(scanId, kind);
  }

  public async upsertCandidateGroup(
    rootId: string,
    scanId: string,
    group: CandidateSizeGroup,
    updatedAt: string,
  ): Promise<string> {
    const groupKey = `size:${group.byteLength}`;
    const id = stableId("duplicate-candidate-v2", scanId, group.byteLength);
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO duplicate_groups (
        id, root_id, scan_id, kind, group_key, copy_count, byte_length,
        total_bytes, reclaimable_bytes, verification_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, 'candidate', ?, ?)
      ON CONFLICT(scan_id, kind, group_key) DO UPDATE SET
        copy_count = excluded.copy_count,
        total_bytes = excluded.total_bytes,
        reclaimable_bytes = excluded.reclaimable_bytes,
        updated_at = excluded.updated_at`).run(
          id,
          rootId,
          scanId,
          groupKey,
          group.copyCount,
          group.byteLength,
          safeMultiply(group.copyCount, group.byteLength),
          safeMultiply(group.copyCount - 1, group.byteLength),
          updatedAt,
          updatedAt,
        );
      this.#database.prepare(`INSERT OR REPLACE INTO duplicate_group_members (
        group_id, record_id, root_id, scan_id, relative_path, name, byte_length,
        created_at, modified_at, hash_state, decision
      ) SELECT ?, r.id, r.root_id, r.scan_id, r.relative_path, r.name, r.byte_length,
        r.created_at, r.modified_at, COALESCE(h.verification_state, 'not-hashed'),
        COALESCE((SELECT old.decision FROM duplicate_group_members old
          WHERE old.group_id = ? AND old.record_id = r.id), 'undecided')
      FROM inventory_records r
      LEFT JOIN file_hashes h ON h.record_id = r.id
      WHERE r.scan_id = ? AND r.observation_status = 'observed'
        AND r.entry_type = 'file' AND r.byte_length = ?`).run(
          id,
          id,
          scanId,
          group.byteLength,
        );
    });
    return id;
  }

  public async upsertExactGroup(
    rootId: string,
    scanId: string,
    group: ExactHashGroup,
    updatedAt: string,
  ): Promise<string> {
    const groupKey = `sha256:${group.digestHex}:${group.byteLength}`;
    const id = stableId("duplicate-exact-v2", scanId, group.digestHex, group.byteLength);
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO duplicate_groups (
        id, root_id, scan_id, kind, group_key, copy_count, byte_length,
        total_bytes, reclaimable_bytes, verification_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'exact', ?, ?, ?, ?, ?, 'verified', ?, ?)
      ON CONFLICT(scan_id, kind, group_key) DO UPDATE SET
        copy_count = excluded.copy_count,
        total_bytes = excluded.total_bytes,
        reclaimable_bytes = excluded.reclaimable_bytes,
        verification_state = 'verified', updated_at = excluded.updated_at`).run(
          id,
          rootId,
          scanId,
          groupKey,
          group.copyCount,
          group.byteLength,
          safeMultiply(group.copyCount, group.byteLength),
          safeMultiply(group.copyCount - 1, group.byteLength),
          updatedAt,
          updatedAt,
        );
      this.#database.prepare(`INSERT OR REPLACE INTO duplicate_group_members (
        group_id, record_id, root_id, scan_id, relative_path, name, byte_length,
        created_at, modified_at, hash_state, decision
      ) SELECT ?, r.id, r.root_id, r.scan_id, r.relative_path, r.name, r.byte_length,
        r.created_at, r.modified_at, h.verification_state,
        COALESCE((SELECT old.decision FROM duplicate_group_members old
          WHERE old.group_id = ? AND old.record_id = r.id), 'undecided')
      FROM file_hashes h JOIN inventory_records r ON r.id = h.record_id
      WHERE h.scan_id = ? AND h.digest_hex = ? AND h.byte_length = ?`).run(
          id,
          id,
          scanId,
          group.digestHex,
          group.byteLength,
        );
      // The exact duplicate group itself is the durable relationship model.
      // Avoid materializing O(n²) pair rows for large groups.
    });
    return id;
  }

  public async duplicateGroups(query: DuplicateGroupQuery = {}): Promise<DuplicateGroupPage> {
    const limit = boundedLimit(query.limit, 50, 200);
    const offset = decodeOffsetCursor(query.cursor, "duplicates");
    const where: string[] = ["1 = 1"];
    const args: (string | number)[] = [];
    if (query.rootId !== undefined) {
      where.push("g.root_id = ?");
      args.push(query.rootId);
    }
    if (query.kind !== undefined) {
      where.push("g.kind = ?");
      args.push(query.kind);
    }
    if (query.verificationState !== undefined) {
      where.push("g.verification_state = ?");
      args.push(query.verificationState);
    }
    if (query.minimumReclaimableBytes !== undefined) {
      where.push("g.reclaimable_bytes >= ?");
      args.push(nonNegativeInteger(query.minimumReclaimableBytes, "minimumReclaimableBytes"));
    }
    if (query.search !== undefined && query.search.trim().length > 0) {
      where.push(`EXISTS (SELECT 1 FROM duplicate_group_members sm
        WHERE sm.group_id = g.id AND (sm.relative_path LIKE ? ESCAPE '\\' OR sm.name LIKE ? ESCAPE '\\'))`);
      const pattern = `%${escapeLike(query.search.trim())}%`;
      args.push(pattern, pattern);
    }
    const order = query.sort === "copies-desc"
      ? "g.copy_count DESC, g.id DESC"
      : query.sort === "size-desc"
        ? "g.byte_length DESC, g.id DESC"
        : query.sort === "updated-desc"
          ? "g.updated_at DESC, g.id DESC"
          : "g.reclaimable_bytes DESC, g.id DESC";
    const rows = this.#database.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM duplicate_group_members km
        WHERE km.group_id = g.id AND km.decision IN ('keep', 'keep-all')) AS keeper_count
      FROM duplicate_groups g WHERE ${where.join(" AND ")}
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit + 1, offset) as unknown as DuplicateGroupRow[];
    return {
      items: rows.slice(0, limit).map(duplicateGroupFromRow),
      ...(rows.length > limit ? { nextCursor: encodeOffsetCursor("duplicates", offset + limit) } : {}),
    };
  }

  public async duplicateGroup(id: string): Promise<DuplicateGroupSummary | undefined> {
    const row = this.#database.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM duplicate_group_members km
        WHERE km.group_id = g.id AND km.decision IN ('keep', 'keep-all')) AS keeper_count
      FROM duplicate_groups g WHERE g.id = ?`).get(id) as unknown as DuplicateGroupRow | undefined;
    return row === undefined ? undefined : duplicateGroupFromRow(row);
  }

  public async duplicateMembers(
    groupId: string,
    limit = 100,
    cursor?: string,
  ): Promise<DuplicateMemberPage> {
    const bounded = boundedLimit(limit, 100, 500);
    const offset = decodeOffsetCursor(cursor, "duplicate-members");
    const rows = this.#database.prepare(`SELECT m.* FROM duplicate_group_members m
      WHERE m.group_id = ? ORDER BY m.relative_path, m.record_id LIMIT ? OFFSET ?`)
      .all(groupId, bounded + 1, offset) as unknown as Array<{
        group_id: string;
        record_id: string;
        root_id: string;
        scan_id: string;
        relative_path: string;
        name: string;
        byte_length: number;
        created_at: string | null;
        modified_at: string | null;
        hash_state: DuplicateGroupMember["hashState"];
        decision: DuplicateGroupMember["decision"];
      }>;
    return {
      items: rows.slice(0, bounded).map((row) => ({
        groupId: row.group_id,
        recordId: row.record_id,
        rootId: row.root_id,
        scanId: row.scan_id,
        relativePath: row.relative_path,
        name: row.name,
        byteLength: row.byte_length,
        ...(row.created_at === null ? {} : { createdAt: row.created_at }),
        ...(row.modified_at === null ? {} : { modifiedAt: row.modified_at }),
        hashState: row.hash_state,
        decision: row.decision,
      })),
      ...(rows.length > bounded
        ? { nextCursor: encodeOffsetCursor("duplicate-members", offset + bounded) }
        : {}),
    };
  }

  public async decideDuplicateGroup(
    groupId: string,
    keeperRecordIds: readonly string[],
    keepEverything: boolean,
    updatedAt: string,
  ): Promise<DuplicateGroupSummary> {
    this.#transaction(() => {
      const group = this.#database.prepare("SELECT id FROM duplicate_groups WHERE id = ?")
        .get(groupId);
      if (group === undefined) throw new Error("The duplicate group does not exist.");
      if (keepEverything) {
        this.#database.prepare(`UPDATE duplicate_group_members SET decision = 'keep-all'
          WHERE group_id = ?`).run(groupId);
      } else {
        if (keeperRecordIds.length === 0) {
          throw new Error("Select at least one keeper or choose keep everything.");
        }
        this.#database.prepare(`UPDATE duplicate_group_members SET decision = 'consolidate'
          WHERE group_id = ?`).run(groupId);
        const keep = this.#database.prepare(`UPDATE duplicate_group_members SET decision = 'keep'
          WHERE group_id = ? AND record_id = ?`);
        for (const recordId of new Set(keeperRecordIds)) {
          const result = keep.run(groupId, recordId);
          if (Number(result.changes) !== 1) {
            throw new Error("A selected keeper is not a member of this duplicate group.");
          }
        }
      }
      this.#database.prepare("UPDATE duplicate_groups SET updated_at = ? WHERE id = ?")
        .run(updatedAt, groupId);
      this.#database.prepare(`UPDATE needs_review SET status = 'resolved', resolution_json = ?, resolved_at = ?
        WHERE group_id = ? AND reason = 'duplicate-keeper-uncertain' AND status = 'open'`)
        .run(JSON.stringify({ keepEverything, keeperRecordIds }), updatedAt, groupId);
    });
    const saved = await this.duplicateGroup(groupId);
    if (saved === undefined) throw new Error("The duplicate group disappeared.");
    return saved;
  }

  public async analysisTasks(
    scanId: string,
    limit: number,
    afterRelativePath?: string,
    afterRecordId?: string,
  ): Promise<readonly HashTask[]> {
    const bounded = boundedLimit(limit, 100, 500);
    const cursor = afterRelativePath === undefined
      ? ""
      : "AND (relative_path > ? OR (relative_path = ? AND id > ?))";
    const args: (string | number)[] = [scanId];
    if (afterRelativePath !== undefined) {
      args.push(afterRelativePath, afterRelativePath, afterRecordId ?? "");
    }
    args.push(bounded);
    const rows = this.#database.prepare(`SELECT
      id, root_id, scan_id, relative_path, name, extension, byte_length,
      modified_at, device_id, filesystem_record_id
      FROM inventory_records
      WHERE scan_id = ? AND entry_type = 'file' AND observation_status = 'observed'
        AND byte_length IS NOT NULL ${cursor}
      ORDER BY relative_path, id LIMIT ?`).all(...args) as unknown as HashTaskRow[];
    return rows.map(hashTaskFromRow);
  }

  public async analyzerResult(
    recordId: string,
    analyzerId: string,
    analyzerVersion: string,
    observationSignature: string,
  ): Promise<PersistedAnalysisResult | undefined> {
    const row = this.#database.prepare(`SELECT * FROM analyzer_results
      WHERE record_id = ? AND analyzer_id = ? AND analyzer_version = ?
        AND observation_signature = ?`).get(
          recordId,
          analyzerId,
          analyzerVersion,
          observationSignature,
        ) as unknown as AnalyzerResultRow | undefined;
    return row === undefined ? undefined : analysisResultFromRow(row);
  }

  public async reusableAnalyzerResult(
    rootId: string,
    recordId: string,
    analyzerId: string,
    analyzerVersion: string,
    observationSignature: string,
  ): Promise<PersistedAnalysisResult | undefined> {
    const row = this.#database.prepare(`SELECT * FROM analyzer_results
      WHERE root_id = ? AND record_id <> ? AND analyzer_id = ?
        AND analyzer_version = ? AND observation_signature = ?
      ORDER BY analyzed_at DESC LIMIT 1`).get(
        rootId,
        recordId,
        analyzerId,
        analyzerVersion,
        observationSignature,
      ) as unknown as AnalyzerResultRow | undefined;
    return row === undefined ? undefined : analysisResultFromRow(row);
  }

  public async saveAnalyzerResult(result: PersistedAnalysisResult): Promise<void> {
    this.#database.prepare(`INSERT INTO analyzer_results (
      record_id, root_id, scan_id, analyzer_id, analyzer_version,
      observation_signature, status, facts_json, warnings_json,
      error_code, error_message, analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id, analyzer_id, analyzer_version, observation_signature) DO UPDATE SET
      status = excluded.status, facts_json = excluded.facts_json,
      warnings_json = excluded.warnings_json, error_code = excluded.error_code,
      error_message = excluded.error_message, analyzed_at = excluded.analyzed_at`).run(
        result.recordId,
        result.rootId,
        result.scanId,
        result.analyzerId,
        result.analyzerVersion,
        result.observationSignature,
        result.status,
        JSON.stringify(result.facts),
        JSON.stringify(result.warnings),
        result.error?.code ?? null,
        result.error?.message ?? null,
        result.analyzedAt,
      );
  }

  public async saveUnderstanding(value: FileUnderstanding): Promise<void> {
    this.#database.prepare(`INSERT INTO file_understanding (
      record_id, root_id, scan_id, relative_path, parent_path, mime_type,
      category, confidence, classification_layer, explanation, evidence_json,
      uncertainty, analysis_state, capture_at, duration_seconds, width, height,
      metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      parent_path = excluded.parent_path, mime_type = excluded.mime_type,
      category = excluded.category, confidence = excluded.confidence,
      classification_layer = excluded.classification_layer,
      explanation = excluded.explanation, evidence_json = excluded.evidence_json,
      uncertainty = excluded.uncertainty, analysis_state = excluded.analysis_state,
      capture_at = excluded.capture_at, duration_seconds = excluded.duration_seconds,
      width = excluded.width, height = excluded.height,
      metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`).run(
        value.recordId,
        value.rootId,
        value.scanId,
        value.relativePath,
        value.parentPath,
        value.mimeType ?? null,
        value.category,
        value.confidence,
        value.classificationLayer,
        value.explanation,
        JSON.stringify(value.evidence),
        value.uncertainty,
        value.analysisState,
        value.captureAt ?? null,
        value.durationSeconds ?? null,
        value.width ?? null,
        value.height ?? null,
        JSON.stringify(value.metadata),
        value.updatedAt,
      );
  }

  public async understanding(recordId: string): Promise<FileUnderstanding | undefined> {
    const row = this.#database.prepare("SELECT * FROM file_understanding WHERE record_id = ?")
      .get(recordId) as unknown as UnderstandingRow | undefined;
    return row === undefined ? undefined : understandingFromRow(row);
  }

  public async classificationRule(extension: string): Promise<string | undefined> {
    const row = this.#database.prepare(`SELECT category FROM classification_rules
      WHERE extension = ? COLLATE NOCASE`).get(extension) as unknown as
      | { category: string }
      | undefined;
    return row?.category;
  }

  public async createNeedsReview(item: NeedsReviewItem): Promise<void> {
    this.#database.prepare(`INSERT INTO needs_review (
      id, root_id, scan_id, record_id, group_id, reason, title, description,
      evidence_json, status, resolution_json, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, description = excluded.description,
      evidence_json = excluded.evidence_json,
      status = CASE WHEN needs_review.status IN ('resolved', 'dismissed')
        THEN needs_review.status ELSE excluded.status END`)
      .run(
        item.id,
        item.rootId,
        item.scanId,
        item.recordId ?? null,
        item.groupId ?? null,
        item.reason,
        item.title,
        item.description,
        JSON.stringify(item.evidence),
        item.status,
        item.resolution === undefined ? null : JSON.stringify(item.resolution),
        item.createdAt,
        item.resolvedAt ?? null,
      );
  }

  public async needsReview(query: NeedsReviewQuery = {}): Promise<NeedsReviewPage> {
    const limit = boundedLimit(query.limit, 50, 200);
    const offset = decodeOffsetCursor(query.cursor, "needs-review");
    const where: string[] = ["1 = 1"];
    const args: (string | number)[] = [];
    if (query.rootId !== undefined) {
      where.push("root_id = ?");
      args.push(query.rootId);
    }
    if (query.scanId !== undefined) {
      where.push("scan_id = ?");
      args.push(query.scanId);
    }
    if (query.reason !== undefined) {
      where.push("reason = ?");
      args.push(query.reason);
    }
    where.push("status = ?");
    args.push(query.status ?? "open");
    if (query.search !== undefined && query.search.trim().length > 0) {
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(query.search.trim())}%`;
      args.push(pattern, pattern);
    }
    const rows = this.#database.prepare(`SELECT * FROM needs_review
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(
        ...args,
        limit + 1,
        offset,
      ) as unknown as ReviewRow[];
    return {
      items: rows.slice(0, limit).map(reviewFromRow),
      ...(rows.length > limit
        ? { nextCursor: encodeOffsetCursor("needs-review", offset + limit) }
        : {}),
    };
  }

  public async resolveNeedsReview(
    id: string,
    status: "resolved" | "dismissed",
    resolution: JsonObject,
    resolvedAt: string,
    rememberExtensionRule = false,
  ): Promise<NeedsReviewItem> {
    this.#transaction(() => {
      const row = this.#database.prepare("SELECT * FROM needs_review WHERE id = ?")
        .get(id) as unknown as ReviewRow | undefined;
      if (row === undefined) throw new Error("The Needs Review item does not exist.");
      this.#database.prepare(`UPDATE needs_review SET status = ?, resolution_json = ?, resolved_at = ?
        WHERE id = ?`).run(status, JSON.stringify(resolution), resolvedAt, id);
      if (
        status === "resolved" &&
        row.record_id !== null &&
        typeof resolution["category"] === "string"
      ) {
        const category = resolution["category"].trim().slice(0, 100);
        if (category.length > 0) {
          this.#database.prepare(`UPDATE file_understanding SET
            category = ?, confidence = 1, classification_layer = 'context',
            explanation = 'Resolved by the user in Needs Review.',
            evidence_json = ?, uncertainty = 'confident', updated_at = ?
            WHERE record_id = ?`).run(
              category,
              JSON.stringify({ source: "needs-review", reviewId: id }),
              resolvedAt,
              row.record_id,
            );
          if (rememberExtensionRule) {
            const file = this.#database.prepare("SELECT extension FROM inventory_records WHERE id = ?")
              .get(row.record_id) as unknown as { extension: string | null } | undefined;
            if (file?.extension !== null && file?.extension !== undefined) {
              this.#database.prepare(`INSERT INTO classification_rules (
                extension, category, source, use_count, updated_at
              ) VALUES (?, ?, 'user', 1, ?)
              ON CONFLICT(extension) DO UPDATE SET category = excluded.category,
                source = 'user', use_count = classification_rules.use_count + 1,
                updated_at = excluded.updated_at`).run(file.extension, category, resolvedAt);
            }
          }
        }
      }
    });
    const row = this.#database.prepare("SELECT * FROM needs_review WHERE id = ?")
      .get(id) as unknown as ReviewRow | undefined;
    if (row === undefined) throw new Error("The resolved Needs Review item disappeared.");
    return reviewFromRow(row);
  }

  public async projectSignals(
    scanId: string,
    limit: number,
    afterRelativePath?: string,
  ): Promise<readonly { readonly recordId: string; readonly relativePath: string; readonly name: string; readonly entryType: string }[]> {
    const names = [
      "package.json", "pyproject.toml", "cargo.toml", "go.mod", "pom.xml",
      "build.gradle", "build.gradle.kts", "composer.json", "gemfile",
      "readme", "readme.md", "readme.txt", ".git", "src",
    ];
    const placeholders = names.map(() => "?").join(", ");
    const cursor = afterRelativePath === undefined ? "" : "AND relative_path > ?";
    const args: (string | number)[] = [scanId, ...names];
    if (afterRelativePath !== undefined) args.push(afterRelativePath);
    args.push(boundedLimit(limit, 500, 2_000));
    const rows = this.#database.prepare(`SELECT id, relative_path, name, entry_type
      FROM inventory_records
      WHERE scan_id = ? AND observation_status = 'observed'
        AND lower(name) IN (${placeholders}) ${cursor}
      ORDER BY relative_path LIMIT ?`).all(...args) as unknown as Array<{
        id: string;
        relative_path: string;
        name: string;
        entry_type: string;
      }>;
    return rows.map((row) => ({
      recordId: row.id,
      relativePath: row.relative_path,
      name: row.name,
      entryType: row.entry_type,
    }));
  }

  public async observedSignalsAtParent(
    scanId: string,
    parentPath: string,
    names: readonly string[],
  ): Promise<readonly string[]> {
    if (names.length === 0) return [];
    const candidates = names.map((name) => parentPath.length === 0 ? name : `${parentPath}/${name}`);
    const placeholders = candidates.map(() => "?").join(", ");
    const rows = this.#database.prepare(`SELECT lower(name) AS name FROM inventory_records
      WHERE scan_id = ? AND observation_status = 'observed'
        AND lower(relative_path) IN (${placeholders})`).all(
          scanId,
          ...candidates.map((value) => value.toLocaleLowerCase("en-US")),
        ) as unknown as { name: string }[];
    return rows.map((row) => row.name);
  }

  public async mediaPairCandidates(
    scanId: string,
    limit: number,
    afterRelativePath?: string,
  ): Promise<readonly {
    readonly sourceRecordId: string;
    readonly sourceRelativePath: string;
    readonly targetRecordId: string;
    readonly targetRelativePath: string;
    readonly relationship: "derived-version" | "sidecar-of";
  }[]> {
    const raw = ["raw", "dng", "cr2", "nef", "arw", "orf", "rw2"];
    const rendered = ["jpg", "jpeg", "heic", "heif", "tif", "tiff", "png"];
    const sidecars = ["xmp", "aae"];
    const rawSlots = raw.map(() => "?").join(", ");
    const otherSlots = [...rendered, ...sidecars].map(() => "?").join(", ");
    const cursor = afterRelativePath === undefined ? "" : "AND a.relative_path > ?";
    const args: (string | number)[] = [scanId, ...raw, ...rendered, ...sidecars];
    if (afterRelativePath !== undefined) args.push(afterRelativePath);
    args.push(boundedLimit(limit, 250, 1_000));
    const rows = this.#database.prepare(`WITH files AS (
      SELECT r.id, r.relative_path, lower(COALESCE(r.extension, '')) AS extension,
        u.parent_path,
        lower(CASE WHEN r.extension IS NULL THEN r.name
          ELSE substr(r.name, 1, length(r.name) - length(r.extension) - 1) END) AS stem
      FROM inventory_records r JOIN file_understanding u ON u.record_id = r.id
      WHERE r.scan_id = ? AND r.observation_status = 'observed' AND r.entry_type = 'file'
    )
    SELECT a.id AS source_id, a.relative_path AS source_path,
      b.id AS target_id, b.relative_path AS target_path, b.extension AS target_extension
    FROM files a JOIN files b ON b.parent_path = a.parent_path AND b.stem = a.stem AND b.id <> a.id
    WHERE a.extension IN (${rawSlots}) AND b.extension IN (${otherSlots}) ${cursor}
    ORDER BY a.relative_path, b.relative_path LIMIT ?`).all(...args) as unknown as Array<{
      source_id: string;
      source_path: string;
      target_id: string;
      target_path: string;
      target_extension: string;
    }>;
    return rows.map((row) => ({
      sourceRecordId: row.source_id,
      sourceRelativePath: row.source_path,
      targetRecordId: row.target_id,
      targetRelativePath: row.target_path,
      relationship: sidecars.includes(row.target_extension) ? "sidecar-of" : "derived-version",
    }));
  }

  public async albumCandidates(
    scanId: string,
    limit: number,
    afterParentPath?: string,
  ): Promise<readonly { readonly parentPath: string; readonly audioCount: number }[]> {
    const cursor = afterParentPath === undefined ? "" : "AND a.parent_path > ?";
    const args: (string | number)[] = [scanId];
    if (afterParentPath !== undefined) args.push(afterParentPath);
    args.push(boundedLimit(limit, 250, 1_000));
    const rows = this.#database.prepare(`SELECT a.parent_path, COUNT(*) AS audio_count
      FROM file_understanding a
      WHERE a.scan_id = ? AND a.category = 'Audio' ${cursor}
        AND EXISTS (SELECT 1 FROM file_understanding artwork
          WHERE artwork.scan_id = a.scan_id AND artwork.parent_path = a.parent_path
            AND artwork.category = 'Images')
      GROUP BY a.parent_path HAVING COUNT(*) >= 2
      ORDER BY a.parent_path LIMIT ?`).all(...args) as unknown as Array<{
        parent_path: string;
        audio_count: number;
      }>;
    return rows.map((row) => ({ parentPath: row.parent_path, audioCount: row.audio_count }));
  }

  public async recordsInParent(scanId: string, parentPath: string): Promise<readonly string[]> {
    const rows = this.#database.prepare(`SELECT record_id FROM file_understanding
      WHERE scan_id = ? AND parent_path = ? ORDER BY relative_path`).all(
        scanId,
        parentPath,
      ) as unknown as { record_id: string }[];
    return rows.map((row) => row.record_id);
  }

  public async applyGroupContext(
    groupId: string,
    explanation: string,
    evidence: JsonObject,
    confidence: number,
    updatedAt: string,
  ): Promise<void> {
    this.#database.prepare(`UPDATE file_understanding SET
      confidence = MAX(confidence, ?), classification_layer = 'context',
      explanation = ?, evidence_json = ?, uncertainty = 'confident', updated_at = ?
      WHERE record_id IN (SELECT record_id FROM semantic_group_members WHERE group_id = ?)`)
      .run(Math.max(0, Math.min(1, confidence)), explanation, JSON.stringify(evidence), updatedAt, groupId);
  }

  public async clearSemanticAnalysis(scanId: string): Promise<void> {
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM semantic_groups WHERE scan_id = ?").run(scanId);
      this.#database.prepare(`DELETE FROM file_relationships WHERE scan_id = ?
        AND kind <> 'exact-duplicate-of'`).run(scanId);
    });
  }

  public async saveSemanticGroup(
    group: Omit<SemanticGroup, "memberCount">,
    memberMode: { readonly kind: "path-prefix"; readonly relativeRoot: string }
      | { readonly kind: "records"; readonly recordIds: readonly string[] },
  ): Promise<SemanticGroup> {
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO semantic_groups (
        id, root_id, scan_id, kind, display_name, relative_root, confidence,
        provenance, evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
        relative_root = excluded.relative_root, confidence = excluded.confidence,
        provenance = excluded.provenance, evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at`).run(
          group.id,
          group.rootId,
          group.scanId,
          group.kind,
          group.displayName,
          group.relativeRoot ?? null,
          group.confidence,
          group.provenance,
          JSON.stringify(group.evidence),
          group.createdAt,
          group.updatedAt,
        );
      this.#database.prepare("DELETE FROM semantic_group_members WHERE group_id = ?").run(group.id);
      if (memberMode.kind === "path-prefix") {
        if (memberMode.relativeRoot.length === 0) {
          this.#database.prepare(`INSERT INTO semantic_group_members (group_id, record_id, relative_path, role)
            SELECT ?, id, relative_path, 'member' FROM inventory_records
            WHERE scan_id = ? AND observation_status = 'observed' AND entry_type = 'file'`)
            .run(group.id, group.scanId);
        } else {
          this.#database.prepare(`INSERT INTO semantic_group_members (group_id, record_id, relative_path, role)
            SELECT ?, id, relative_path, 'member' FROM inventory_records
            WHERE scan_id = ? AND observation_status = 'observed' AND entry_type = 'file'
              AND (relative_path = ? OR relative_path LIKE ? ESCAPE '\\')`)
            .run(
              group.id,
              group.scanId,
              memberMode.relativeRoot,
              `${escapeLike(memberMode.relativeRoot)}/%`,
            );
        }
      } else {
        const statement = this.#database.prepare(`INSERT OR IGNORE INTO semantic_group_members (
          group_id, record_id, relative_path, role
        ) SELECT ?, id, relative_path, 'member' FROM inventory_records
          WHERE scan_id = ? AND id = ?`);
        for (const recordId of memberMode.recordIds) statement.run(group.id, group.scanId, recordId);
      }
    });
    const saved = await this.semanticGroup(group.id);
    if (saved === undefined) throw new Error("The semantic group disappeared.");
    return saved;
  }

  public async saveRelationship(relationship: FileRelationship): Promise<void> {
    this.#database.prepare(`INSERT OR IGNORE INTO file_relationships (
      id, root_id, scan_id, source_record_id, target_record_id, kind,
      confidence, provenance, evidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      relationship.id,
      relationship.rootId,
      relationship.scanId,
      relationship.sourceRecordId,
      relationship.targetRecordId,
      relationship.kind,
      relationship.confidence,
      relationship.provenance,
      JSON.stringify(relationship.evidence),
      relationship.createdAt,
    );
  }

  public async semanticGroup(id: string): Promise<SemanticGroup | undefined> {
    const row = this.#database.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM semantic_group_members m WHERE m.group_id = g.id) AS member_count
      FROM semantic_groups g WHERE g.id = ?`).get(id) as unknown as SemanticGroupRow | undefined;
    return row === undefined ? undefined : semanticGroupFromRow(row);
  }

  public async semanticGroups(
    rootId: string,
    scanId?: string,
    kind?: SemanticGroupKind,
  ): Promise<readonly SemanticGroup[]> {
    const effectiveScan = scanId ?? this.#latestCompletedScanId(rootId);
    if (effectiveScan === undefined) return [];
    const rows = kind === undefined
      ? this.#database.prepare(`SELECT g.*,
          (SELECT COUNT(*) FROM semantic_group_members m WHERE m.group_id = g.id) AS member_count
          FROM semantic_groups g WHERE g.root_id = ? AND g.scan_id = ?
          ORDER BY g.kind, g.relative_root, g.id`).all(rootId, effectiveScan)
      : this.#database.prepare(`SELECT g.*,
          (SELECT COUNT(*) FROM semantic_group_members m WHERE m.group_id = g.id) AS member_count
          FROM semantic_groups g WHERE g.root_id = ? AND g.scan_id = ? AND g.kind = ?
          ORDER BY g.relative_root, g.id`).all(rootId, effectiveScan, kind);
    return (rows as unknown as SemanticGroupRow[]).map(semanticGroupFromRow);
  }

  public async enrichedInventory(
    rootId: string,
    query: EnrichedInventoryQuery = {},
  ): Promise<EnrichedInventoryPage> {
    const scanId = query.scanId ?? this.#latestCompletedScanId(rootId);
    if (scanId === undefined) return { items: [] };
    const limit = boundedLimit(query.limit, 100, 200);
    const cursor = decodeKeyCursor(query.cursor, "inventory");
    const where = [
      "r.root_id = ?", "r.scan_id = ?", "r.entry_type = 'file'", "r.observation_status = 'observed'",
    ];
    const args: (string | number)[] = [rootId, scanId];
    if (query.search !== undefined && query.search.trim().length > 0) {
      where.push("(r.name LIKE ? ESCAPE '\\' OR r.relative_path LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(query.search.trim())}%`;
      args.push(pattern, pattern);
    }
    addEquality(where, args, "lower(r.extension)", query.extension?.toLocaleLowerCase("en-US"));
    addEquality(where, args, "u.category", query.category);
    if (query.mimeType !== undefined) {
      where.push("u.mime_type LIKE ? ESCAPE '\\'");
      args.push(`${escapeLike(query.mimeType)}%`);
    }
    addRange(where, args, "r.byte_length", query.minimumBytes, query.maximumBytes);
    addDateRange(where, args, "r.modified_at", query.modifiedAfter, query.modifiedBefore);
    addDateRange(where, args, "u.capture_at", query.captureAfter, query.captureBefore);
    if (query.hashState === "not-requested") where.push("h.record_id IS NULL");
    if (query.hashState === "verified") where.push("h.verification_state = 'verified'");
    if (query.hashState === "reused") where.push("h.verification_state = 'reused'");
    if (query.analysisState === "not-analyzed") where.push("u.record_id IS NULL");
    if (query.analysisState !== undefined && query.analysisState !== "not-analyzed") {
      where.push("u.analysis_state = ?");
      args.push(query.analysisState);
    }
    if (query.needsReview !== undefined) {
      where.push(`${query.needsReview ? "" : "NOT "}EXISTS (
        SELECT 1 FROM needs_review nr WHERE nr.record_id = r.id AND nr.status = 'open'
      )`);
    }
    if (query.semanticGroupId !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM semantic_group_members sgm
        WHERE sgm.record_id = r.id AND sgm.group_id = ?)`);
      args.push(query.semanticGroupId);
    }
    if (query.duplicateState === "none") {
      where.push("NOT EXISTS (SELECT 1 FROM duplicate_group_members dm WHERE dm.record_id = r.id)");
    } else if (query.duplicateState !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM duplicate_group_members dm
        JOIN duplicate_groups dg ON dg.id = dm.group_id
        WHERE dm.record_id = r.id AND dg.kind = ?)`);
      args.push(query.duplicateState);
    }
    if (cursor !== undefined) {
      where.push("(r.relative_path > ? OR (r.relative_path = ? AND r.id > ?))");
      args.push(cursor.key, cursor.key, cursor.id);
    }
    const rows = this.#database.prepare(`SELECT
      r.id, r.root_id, r.scan_id, r.relative_path, r.name, r.extension,
      r.byte_length, r.created_at, r.modified_at,
      h.verification_state,
      u.mime_type, u.category, u.capture_at, u.duration_seconds, u.analysis_state,
      EXISTS (SELECT 1 FROM needs_review nr WHERE nr.record_id = r.id AND nr.status = 'open') AS needs_review,
      CASE
        WHEN EXISTS (SELECT 1 FROM duplicate_group_members dm JOIN duplicate_groups dg
          ON dg.id = dm.group_id WHERE dm.record_id = r.id AND dg.kind = 'exact') THEN 'exact'
        WHEN EXISTS (SELECT 1 FROM duplicate_group_members dm JOIN duplicate_groups dg
          ON dg.id = dm.group_id WHERE dm.record_id = r.id AND dg.kind = 'candidate') THEN 'candidate'
        ELSE 'none'
      END AS duplicate_state
      FROM inventory_records r
      LEFT JOIN file_hashes h ON h.record_id = r.id
      LEFT JOIN file_understanding u ON u.record_id = r.id
      WHERE ${where.join(" AND ")}
      ORDER BY r.relative_path, r.id LIMIT ?`).all(...args, limit + 1) as unknown as EnrichedRow[];
    const visible = rows.slice(0, limit);
    const groups = this.#groupsForRecords(visible.map((row) => row.id));
    const items = visible.map((row) => enrichedFromRow(row, groups.get(row.id) ?? []));
    const last = visible.at(-1);
    return {
      items,
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeKeyCursor("inventory", last.relative_path, last.id) }
        : {}),
    };
  }

  public async organizationPlanningEvidence(
    recordIds: readonly string[],
  ): Promise<ReadonlyMap<string, OrganizationPlanningEvidence>> {
    if (recordIds.length === 0) return new Map();
    const placeholders = recordIds.map(() => "?").join(", ");
    const rows = this.#database.prepare(`SELECT record_id, category, capture_at,
      uncertainty, explanation FROM file_understanding
      WHERE record_id IN (${placeholders})`).all(...recordIds) as unknown as Array<{
        record_id: string;
        category: string;
        capture_at: string | null;
        uncertainty: "confident" | "needs-review";
        explanation: string;
      }>;
    const openReviewRecords = new Set(
      (this.#database.prepare(`SELECT DISTINCT COALESCE(nr.record_id, dm.record_id) AS record_id
        FROM needs_review nr
        LEFT JOIN duplicate_group_members dm ON dm.group_id = nr.group_id
        WHERE nr.status = 'open'
          AND (nr.record_id IN (${placeholders}) OR dm.record_id IN (${placeholders}))`)
        .all(...recordIds, ...recordIds) as unknown as Array<{ record_id: string }>)
        .map((review) => review.record_id),
    );

    const groups = this.#groupsForRecords(recordIds);
    const result = new Map<string, OrganizationPlanningEvidence>();
    for (const recordId of recordIds) {
      const row = rows.find((candidate) => candidate.record_id === recordId);
      const hasOpenReview = openReviewRecords.has(recordId);
      result.set(recordId, {
        recordId,
        ...(row === undefined ? {} : { category: row.category }),
        ...(row?.capture_at === null || row?.capture_at === undefined ? {} : { captureAt: row.capture_at }),
        ...(hasOpenReview
          ? { uncertainty: "needs-review" as const,
              explanation: "An unresolved Needs Review item blocks automatic organization." }
          : row === undefined
            ? {}
            : { uncertainty: row.uncertainty, explanation: row.explanation }),
        semanticGroups: groups.get(recordId) ?? [],
      });
    }
    return result;
  }

  public async createReconciliation(input: {
    readonly id: string;
    readonly rootId: string;
    readonly baselineScanId: string;
    readonly comparisonScanId: string;
    readonly createdAt: string;
  }): Promise<PersistedReconciliation> {
    const scans = this.#database.prepare(`SELECT id, root_id, status FROM inventory_scan_sessions
      WHERE id IN (?, ?)`).all(input.baselineScanId, input.comparisonScanId) as unknown as Array<{
        id: string;
        root_id: string;
        status: string;
      }>;
    if (scans.length !== 2) throw new Error("Both inventory scans must exist.");
    if (scans.some((scan) => scan.root_id !== input.rootId)) {
      throw new Error("Both scan sessions must belong to the same library root.");
    }
    if (scans.some((scan) => scan.status !== "completed")) {
      throw new Error("Only completed inventory scans can be reconciled.");
    }
    this.#database.prepare(`INSERT OR IGNORE INTO reconciliation_runs (
      id, root_id, baseline_scan_id, comparison_scan_id, status, phase,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 'missing', ?, ?)`).run(
      input.id,
      input.rootId,
      input.baselineScanId,
      input.comparisonScanId,
      input.createdAt,
      input.createdAt,
    );
    const existing = this.#database.prepare(`SELECT * FROM reconciliation_runs
      WHERE root_id = ? AND baseline_scan_id = ? AND comparison_scan_id = ?`).get(
        input.rootId,
        input.baselineScanId,
        input.comparisonScanId,
      ) as unknown as ReconciliationRow;
    return reconciliationFromRow(existing);
  }

  public async attachReconciliationJob(
    id: string,
    jobId: string,
    updatedAt: string,
  ): Promise<PersistedReconciliation> {
    const result = this.#database.prepare(`UPDATE reconciliation_runs
      SET job_id = COALESCE(job_id, ?), updated_at = ? WHERE id = ?`).run(jobId, updatedAt, id);
    if (Number(result.changes) !== 1) throw new Error("The reconciliation run does not exist.");
    const saved = await this.reconciliation(id);
    if (saved === undefined) throw new Error("The reconciliation run disappeared.");
    return saved;
  }

  public async reconciliation(id: string): Promise<PersistedReconciliation | undefined> {
    const row = this.#database.prepare("SELECT * FROM reconciliation_runs WHERE id = ?")
      .get(id) as unknown as ReconciliationRow | undefined;
    return row === undefined ? undefined : reconciliationFromRow(row);
  }

  public async reconciliations(
    rootId?: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ readonly items: readonly PersistedReconciliation[]; readonly nextCursor?: string }> {
    const bounded = boundedLimit(limit, 50, 200);
    const offset = decodeOffsetCursor(cursor, "reconciliations");
    const rows = rootId === undefined
      ? this.#database.prepare(`SELECT * FROM reconciliation_runs
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(bounded + 1, offset)
      : this.#database.prepare(`SELECT * FROM reconciliation_runs
          WHERE root_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(rootId, bounded + 1, offset);
    const values = rows as unknown as ReconciliationRow[];
    return {
      items: values.slice(0, bounded).map(reconciliationFromRow),
      ...(values.length > bounded
        ? { nextCursor: encodeOffsetCursor("reconciliations", offset + bounded) }
        : {}),
    };
  }

  public async setReconciliationState(
    id: string,
    input: {
      readonly status: ReconciliationStatus;
      readonly phase?: PersistedReconciliation["phase"];
      readonly error?: { readonly code: string; readonly message: string };
      readonly updatedAt: string;
    },
  ): Promise<PersistedReconciliation> {
    const terminal = ["completed", "failed", "cancelled"].includes(input.status);
    const result = this.#database.prepare(`UPDATE reconciliation_runs SET
      status = ?, phase = COALESCE(?, phase), updated_at = ?,
      completed_at = ?, error_code = ?, error_message = ?
      WHERE id = ?`).run(
        input.status,
        input.phase ?? null,
        input.updatedAt,
        terminal ? input.updatedAt : null,
        input.error?.code ?? null,
        input.error?.message ?? null,
        id,
      );
    if (Number(result.changes) !== 1) throw new Error("The reconciliation run does not exist.");
    const saved = await this.reconciliation(id);
    if (saved === undefined) throw new Error("The reconciliation run disappeared.");
    return saved;
  }

  public async reconciliationWork(
    id: string,
    kind: ReconciliationDeltaKind,
    afterRelativePath: string | undefined,
    limit: number,
  ): Promise<readonly ReconciliationWorkItem[]> {
    const run = await this.reconciliation(id);
    if (run === undefined) throw new Error("The reconciliation run does not exist.");
    const bounded = boundedLimit(limit, 500, 2_000);
    const cursor = afterRelativePath === undefined ? "" : "AND b.relative_path > ?";
    const args: (string | number)[] = [run.comparisonScanId, run.baselineScanId];
    if (afterRelativePath !== undefined) args.push(afterRelativePath);
    args.push(bounded);
    if (kind === "missing") {
      const rows = this.#database.prepare(`SELECT
        b.relative_path,
        b.entry_type AS b_entry_type, b.byte_length AS b_byte_length,
        b.modified_at AS b_modified_at, b.hidden AS b_hidden,
        b.system AS b_system, b.read_only AS b_read_only
        FROM inventory_records b
        LEFT JOIN inventory_records c ON c.scan_id = ?
          AND c.observation_status = 'observed' AND c.relative_path = b.relative_path
        WHERE b.scan_id = ? AND b.observation_status = 'observed'
          AND c.id IS NULL ${afterRelativePath === undefined ? "" : "AND b.relative_path > ?"}
        ORDER BY b.relative_path LIMIT ?`).all(
          run.comparisonScanId,
          run.baselineScanId,
          ...(afterRelativePath === undefined ? [] : [afterRelativePath]),
          bounded,
        ) as unknown as ReconciliationFactRow[];
      return rows.map((row) => ({
        relativePath: row.relative_path,
        before: factsFromPrefixedRow(row, "b"),
        changedFields: [],
      }));
    }
    if (kind === "added") {
      const rows = this.#database.prepare(`SELECT
        b.relative_path,
        b.entry_type AS b_entry_type, b.byte_length AS b_byte_length,
        b.modified_at AS b_modified_at, b.hidden AS b_hidden,
        b.system AS b_system, b.read_only AS b_read_only
        FROM inventory_records b
        LEFT JOIN inventory_records c ON c.scan_id = ?
          AND c.observation_status = 'observed' AND c.relative_path = b.relative_path
        WHERE b.scan_id = ? AND b.observation_status = 'observed'
          AND c.id IS NULL ${afterRelativePath === undefined ? "" : "AND b.relative_path > ?"}
        ORDER BY b.relative_path LIMIT ?`).all(
          run.baselineScanId,
          run.comparisonScanId,
          ...(afterRelativePath === undefined ? [] : [afterRelativePath]),
          bounded,
        ) as unknown as ReconciliationFactRow[];
      return rows.map((row) => ({
        relativePath: row.relative_path,
        after: factsFromPrefixedRow(row, "b"),
        changedFields: [],
      }));
    }
    const rows = this.#database.prepare(`SELECT
      b.relative_path,
      b.entry_type AS b_entry_type, b.byte_length AS b_byte_length,
      b.modified_at AS b_modified_at, b.hidden AS b_hidden,
      b.system AS b_system, b.read_only AS b_read_only,
      c.entry_type AS c_entry_type, c.byte_length AS c_byte_length,
      c.modified_at AS c_modified_at, c.hidden AS c_hidden,
      c.system AS c_system, c.read_only AS c_read_only
      FROM inventory_records b JOIN inventory_records c
        ON c.scan_id = ? AND c.observation_status = 'observed'
        AND c.relative_path = b.relative_path
      WHERE b.scan_id = ? AND b.observation_status = 'observed'
        AND (
          b.entry_type <> c.entry_type OR
          COALESCE(b.byte_length, -1) <> COALESCE(c.byte_length, -1) OR
          COALESCE(b.modified_at, '') <> COALESCE(c.modified_at, '') OR
          COALESCE(b.hidden, -1) <> COALESCE(c.hidden, -1) OR
          COALESCE(b.system, -1) <> COALESCE(c.system, -1) OR
          COALESCE(b.read_only, -1) <> COALESCE(c.read_only, -1)
        ) ${cursor}
      ORDER BY b.relative_path LIMIT ?`).all(...args) as unknown as ReconciliationFactRow[];
    return rows.map((row) => {
      const before = factsFromPrefixedRow(row, "b");
      const after = factsFromPrefixedRow(row, "c");
      return {
        relativePath: row.relative_path,
        before,
        after,
        changedFields: changedFactFields(before, after),
      };
    });
  }

  public async saveReconciliationWork(
    id: string,
    kind: ReconciliationDeltaKind,
    items: readonly ReconciliationWorkItem[],
    updatedAt: string,
  ): Promise<PersistedReconciliation> {
    this.#transaction(() => {
      const insert = this.#database.prepare(`INSERT OR IGNORE INTO reconciliation_deltas (
        reconciliation_id, relative_path, kind, changed_fields_json, before_json, after_json
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      let inserted = 0;
      for (const item of items) {
        inserted += Number(insert.run(
          id,
          item.relativePath,
          kind,
          JSON.stringify(item.changedFields),
          item.before === undefined ? null : JSON.stringify(item.before),
          item.after === undefined ? null : JSON.stringify(item.after),
        ).changes);
      }
      this.#database.prepare(`UPDATE reconciliation_runs SET
        processed = processed + ?,
        added_count = added_count + ?,
        missing_count = missing_count + ?,
        changed_count = changed_count + ?,
        updated_at = ? WHERE id = ?`).run(
          inserted,
          kind === "added" ? inserted : 0,
          kind === "missing" ? inserted : 0,
          kind === "metadata-changed" ? inserted : 0,
          updatedAt,
          id,
        );
    });
    const saved = await this.reconciliation(id);
    if (saved === undefined) throw new Error("The reconciliation run disappeared.");
    return saved;
  }

  public async reconciliationDeltas(
    id: string,
    input: {
      readonly kind?: ReconciliationDeltaKind;
      readonly search?: string;
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): Promise<ReconciliationDeltaPage> {
    const limit = boundedLimit(input.limit, 100, 500);
    const afterId = decodeNumericCursor(input.cursor, "reconciliation-deltas");
    const where = ["reconciliation_id = ?", "id > ?"];
    const args: (string | number)[] = [id, afterId];
    if (input.kind !== undefined) {
      where.push("kind = ?");
      args.push(input.kind);
    }
    if (input.search !== undefined && input.search.trim().length > 0) {
      where.push("relative_path LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(input.search.trim())}%`);
    }
    const rows = this.#database.prepare(`SELECT * FROM reconciliation_deltas
      WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).all(...args, limit + 1) as unknown as Array<{
        id: number;
        reconciliation_id: string;
        relative_path: string;
        kind: ReconciliationDeltaKind;
        changed_fields_json: string;
        before_json: string | null;
        after_json: string | null;
      }>;
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row): PersistedReconciliationDelta => ({
        id: row.id,
        reconciliationId: row.reconciliation_id,
        relativePath: row.relative_path,
        kind: row.kind,
        changedFields: parseStringArray(row.changed_fields_json),
        ...(row.before_json === null ? {} : { before: parseJsonObject(row.before_json) }),
        ...(row.after_json === null ? {} : { after: parseJsonObject(row.after_json) }),
      })),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeNumericCursor("reconciliation-deltas", last.id) }
        : {}),
    };
  }

  #migrate(): void {
    this.#database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const current = Number((this.#database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as unknown as { version: number }).version);
    if (current >= CURRENT_SCHEMA_VERSION) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (current < 1) {
        this.#database.prepare(`INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (1, 'v1-unversioned-inventory-baseline', ?)`).run(new Date().toISOString());
      }
      if (current < 2) {
        const core = this.#database.prepare(`SELECT 1 AS present FROM sqlite_master
          WHERE type = 'table' AND name = 'inventory_records'`).get();
        if (core === undefined) {
          throw new Error("The V1 inventory schema must exist before applying intelligence migrations.");
        }
        this.#database.exec(INTELLIGENCE_SCHEMA);
        this.#database.prepare(`INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (2, 'v2-content-intelligence', ?)`).run(new Date().toISOString());
      }
      this.#database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #latestCompletedScanId(rootId: string): string | undefined {
    const row = this.#database.prepare(`SELECT id FROM inventory_scan_sessions
      WHERE root_id = ? AND status = 'completed'
      ORDER BY started_at DESC, id DESC LIMIT 1`).get(rootId) as unknown as
      | { id: string }
      | undefined;
    return row?.id;
  }

  #requireStage(scanId: string, stage: AnalysisStageName): StageRow {
    const row = this.#database.prepare(`SELECT * FROM analysis_stages WHERE scan_id = ? AND stage = ?`)
      .get(scanId, stage) as unknown as StageRow | undefined;
    if (row === undefined) throw new Error(`Analysis stage ${stage} does not exist for scan ${scanId}.`);
    return row;
  }

  #groupsForRecords(recordIds: readonly string[]): Map<string, EnrichedInventoryItem["semanticGroups"]> {
    if (recordIds.length === 0) return new Map();
    const placeholders = recordIds.map(() => "?").join(", ");
    const rows = this.#database.prepare(`SELECT m.record_id, g.id, g.kind, g.display_name
      FROM semantic_group_members m JOIN semantic_groups g ON g.id = m.group_id
      WHERE m.record_id IN (${placeholders}) ORDER BY g.kind, g.display_name`)
      .all(...recordIds) as unknown as Array<{
        record_id: string;
        id: string;
        kind: SemanticGroupKind;
        display_name: string;
      }>;
    const result = new Map<string, Array<{ id: string; kind: SemanticGroupKind; displayName: string }>>();
    for (const row of rows) {
      const values = result.get(row.record_id) ?? [];
      values.push({ id: row.id, kind: row.kind, displayName: row.display_name });
      result.set(row.record_id, values);
    }
    return result;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function stageFromRow(row: StageRow): AnalysisStageState {
  return {
    rootId: row.root_id,
    scanId: row.scan_id,
    stage: row.stage,
    status: row.status,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    processed: row.processed,
    ...(row.total === null ? {} : { total: row.total }),
    details: parseJsonObject(row.details_json),
    ...(row.error_code === null
      ? {}
      : { error: { code: row.error_code, message: row.error_message ?? "Analysis stage failed." } }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function emptyAnalysisTotals(): AnalysisStatus["totals"] {
  return {
    files: 0,
    analyzed: 0,
    hashesVerified: 0,
    hashesReused: 0,
    candidateDuplicateGroups: 0,
    exactDuplicateGroups: 0,
    needsReview: 0,
    semanticGroups: 0,
  };
}

function hashTaskFromRow(row: HashTaskRow): HashTask {
  return {
    recordId: row.id,
    rootId: row.root_id,
    scanId: row.scan_id,
    relativePath: row.relative_path,
    name: row.name,
    ...(row.extension === null ? {} : { extension: row.extension }),
    byteLength: row.byte_length,
    ...(row.modified_at === null ? {} : { modifiedAt: row.modified_at }),
    ...(row.device_id === null ? {} : { deviceId: row.device_id }),
    ...(row.filesystem_record_id === null
      ? {}
      : { filesystemRecordId: row.filesystem_record_id }),
  };
}

function hashFromRow(row: HashRow): ContentHashObservation {
  return {
    recordId: row.record_id,
    rootId: row.root_id,
    scanId: row.scan_id,
    relativePath: row.relative_path,
    algorithm: row.algorithm,
    digestHex: row.digest_hex,
    byteLength: row.byte_length,
    ...(row.observed_modified_at === null ? {} : { observedModifiedAt: row.observed_modified_at }),
    ...(row.observed_device_id === null ? {} : { observedDeviceId: row.observed_device_id }),
    ...(row.observed_filesystem_record_id === null
      ? {}
      : { observedFilesystemRecordId: row.observed_filesystem_record_id }),
    hashedAt: row.hashed_at,
    verificationState: row.verification_state,
    ...(row.reused_from_record_id === null ? {} : { reusedFromRecordId: row.reused_from_record_id }),
  };
}

function duplicateGroupFromRow(row: DuplicateGroupRow): DuplicateGroupSummary {
  return {
    id: row.id,
    rootId: row.root_id,
    scanId: row.scan_id,
    kind: row.kind,
    groupKey: row.group_key,
    copyCount: row.copy_count,
    byteLength: row.byte_length,
    totalBytes: row.total_bytes,
    reclaimableBytes: row.reclaimable_bytes,
    verificationState: row.verification_state,
    keeperCount: Number(row.keeper_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function analysisResultFromRow(row: AnalyzerResultRow): PersistedAnalysisResult {
  return {
    recordId: row.record_id,
    rootId: row.root_id,
    scanId: row.scan_id,
    analyzerId: row.analyzer_id,
    analyzerVersion: row.analyzer_version,
    observationSignature: row.observation_signature,
    status: row.status,
    facts: parseJsonObject(row.facts_json),
    warnings: parseStringArray(row.warnings_json),
    ...(row.error_code === null
      ? {}
      : { error: { code: row.error_code, message: row.error_message ?? "Analyzer failed." } }),
    analyzedAt: row.analyzed_at,
  };
}

function understandingFromRow(row: UnderstandingRow): FileUnderstanding {
  return {
    recordId: row.record_id,
    rootId: row.root_id,
    scanId: row.scan_id,
    relativePath: row.relative_path,
    parentPath: row.parent_path,
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    category: row.category,
    confidence: row.confidence,
    classificationLayer: row.classification_layer,
    explanation: row.explanation,
    evidence: parseJsonObject(row.evidence_json),
    uncertainty: row.uncertainty,
    analysisState: row.analysis_state,
    ...(row.capture_at === null ? {} : { captureAt: row.capture_at }),
    ...(row.duration_seconds === null ? {} : { durationSeconds: row.duration_seconds }),
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    metadata: parseJsonObject(row.metadata_json),
    updatedAt: row.updated_at,
  };
}

function reviewFromRow(row: ReviewRow): NeedsReviewItem {
  return {
    id: row.id,
    rootId: row.root_id,
    scanId: row.scan_id,
    ...(row.record_id === null ? {} : { recordId: row.record_id }),
    ...(row.group_id === null ? {} : { groupId: row.group_id }),
    reason: row.reason,
    title: row.title,
    description: row.description,
    evidence: parseJsonObject(row.evidence_json),
    status: row.status,
    ...(row.resolution_json === null ? {} : { resolution: parseJsonObject(row.resolution_json) }),
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  };
}

function semanticGroupFromRow(row: SemanticGroupRow): SemanticGroup {
  return {
    id: row.id,
    rootId: row.root_id,
    scanId: row.scan_id,
    kind: row.kind,
    displayName: row.display_name,
    ...(row.relative_root === null ? {} : { relativeRoot: row.relative_root }),
    confidence: row.confidence,
    provenance: row.provenance,
    evidence: parseJsonObject(row.evidence_json),
    memberCount: row.member_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function enrichedFromRow(
  row: EnrichedRow,
  semanticGroups: EnrichedInventoryItem["semanticGroups"],
): EnrichedInventoryItem {
  return {
    recordId: row.id,
    rootId: row.root_id,
    scanId: row.scan_id,
    relativePath: row.relative_path,
    name: row.name,
    ...(row.extension === null ? {} : { extension: row.extension }),
    ...(row.byte_length === null ? {} : { byteLength: row.byte_length }),
    ...(row.created_at === null ? {} : { createdAt: row.created_at }),
    ...(row.modified_at === null ? {} : { modifiedAt: row.modified_at }),
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    ...(row.category === null ? {} : { category: row.category }),
    ...(row.capture_at === null ? {} : { captureAt: row.capture_at }),
    ...(row.duration_seconds === null ? {} : { durationSeconds: row.duration_seconds }),
    hashState: row.verification_state ?? "not-requested",
    duplicateState: row.duplicate_state,
    analysisState: row.analysis_state === "pending" || row.analysis_state === null
      ? "not-analyzed"
      : row.analysis_state,
    needsReview: row.needs_review === 1,
    semanticGroups,
  };
}

function reconciliationFromRow(row: ReconciliationRow): PersistedReconciliation {
  return {
    id: row.id,
    rootId: row.root_id,
    baselineScanId: row.baseline_scan_id,
    comparisonScanId: row.comparison_scan_id,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    status: row.status,
    phase: row.phase,
    processed: row.processed,
    counts: {
      added: row.added_count,
      missing: row.missing_count,
      metadataChanged: row.changed_count,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error_code === null
      ? {}
      : { error: { code: row.error_code, message: row.error_message ?? "Reconciliation failed." } }),
  };
}

function factsFromPrefixedRow(row: ReconciliationFactRow, prefix: "b" | "c"): JsonObject {
  return {
    entryType: String(row[`${prefix}_entry_type`] ?? "unknown"),
    ...(row[`${prefix}_byte_length`] === null
      ? {}
      : { byteLength: Number(row[`${prefix}_byte_length`]) }),
    ...(row[`${prefix}_modified_at`] === null
      ? {}
      : { modifiedAt: String(row[`${prefix}_modified_at`]) }),
    attributes: {
      hidden: row[`${prefix}_hidden`] === 1,
      ...(row[`${prefix}_system`] === null
        ? {}
        : { system: row[`${prefix}_system`] === 1 }),
      ...(row[`${prefix}_read_only`] === null
        ? {}
        : { readOnly: row[`${prefix}_read_only`] === 1 }),
    },
  };
}

function changedFactFields(before: JsonObject, after: JsonObject): readonly string[] {
  const fields: string[] = [];
  for (const key of ["entryType", "byteLength", "modifiedAt", "attributes"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) fields.push(key);
  }
  return fields;
}

function validateResourceSettings(value: unknown): ResourceSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_RESOURCE_SETTINGS;
  const input = value as Partial<ResourceSettings>;
  const local = typeof input.localModel === "object" && input.localModel !== null
    ? input.localModel
    : DEFAULT_RESOURCE_SETTINGS.localModel;
  const integer = (candidate: unknown, fallback: number, maximum: number): number =>
    typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1 && candidate <= maximum
      ? candidate
      : fallback;
  const throughput = ["disk-friendly", "balanced", "maximum"].includes(String(input.throughputMode))
    ? input.throughputMode as ResourceSettings["throughputMode"]
    : DEFAULT_RESOURCE_SETTINGS.throughputMode;
  const depth = ["essentials", "standard", "deep"].includes(String(input.analysisDepth))
    ? input.analysisDepth as ResourceSettings["analysisDepth"]
    : DEFAULT_RESOURCE_SETTINGS.analysisDepth;
  return {
    maximumHashingWorkers: integer(input.maximumHashingWorkers, 1, 8),
    metadataConcurrency: integer(input.metadataConcurrency, 2, 16),
    transferConcurrency: integer(input.transferConcurrency, 1, 4),
    throughputMode: throughput,
    pauseHeavyWork: input.pauseHeavyWork === true,
    analysisDepth: depth,
    localModel: {
      enabled: local.enabled === true,
      adapter: local.adapter === "custom" ? "custom" : "ollama",
      endpoint: typeof local.endpoint === "string" && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/u.test(local.endpoint)
        ? local.endpoint
        : DEFAULT_RESOURCE_SETTINGS.localModel.endpoint,
      model: typeof local.model === "string" ? local.model.slice(0, 200) : "",
      allowTextSamples: local.allowTextSamples === true,
    },
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseJsonObject(value: string): JsonObject {
  const parsed = parseJson(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as JsonObject
    : {};
}

function stableId(prefix: string, ...parts: readonly (string | number)[]): string {
  const hash = createHash("sha256");
  hash.update(`${prefix}\0`, "utf8");
  for (const part of parts) hash.update(`${String(part)}\0`, "utf8");
  return `${prefix}:${hash.digest("hex")}`;
}

function safeMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("A represented byte total exceeds SQLite's safe JavaScript integer range.");
  }
  return value;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error("limit must be a positive integer.");
  return Math.min(value, maximum);
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function encodeOffsetCursor(kind: string, offset: number): string {
  return Buffer.from(JSON.stringify({ kind, offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor: string | undefined, kind: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" && parsed !== null &&
      (parsed as Record<string, unknown>)["kind"] === kind &&
      Number.isSafeInteger((parsed as Record<string, unknown>)["offset"]) &&
      Number((parsed as Record<string, unknown>)["offset"]) >= 0
    ) {
      return Number((parsed as Record<string, unknown>)["offset"]);
    }
  } catch {
    // Rejected below.
  }
  throw new Error(`The ${kind} cursor is invalid.`);
}

function encodeKeyCursor(kind: string, key: string, id: string): string {
  return Buffer.from(JSON.stringify({ kind, key, id }), "utf8").toString("base64url");
}

function decodeKeyCursor(
  cursor: string | undefined,
  kind: string,
): { readonly key: string; readonly id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const row = parsed as Record<string, unknown>;
      if (row["kind"] === kind && typeof row["key"] === "string" && typeof row["id"] === "string") {
        return { key: row["key"], id: row["id"] };
      }
    }
  } catch {
    // Rejected below.
  }
  throw new Error(`The ${kind} cursor is invalid.`);
}

function encodeNumericCursor(kind: string, value: number): string {
  return Buffer.from(JSON.stringify({ kind, value }), "utf8").toString("base64url");
}

function decodeNumericCursor(cursor: string | undefined, kind: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const row = parsed as Record<string, unknown>;
      if (row["kind"] === kind && Number.isSafeInteger(row["value"]) && Number(row["value"]) >= 0) {
        return Number(row["value"]);
      }
    }
  } catch {
    // Rejected below.
  }
  throw new Error(`The ${kind} cursor is invalid.`);
}

function parseStringArray(value: string): readonly string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
}

function addEquality(
  where: string[],
  args: (string | number)[],
  column: string,
  value: string | undefined,
): void {
  if (value === undefined || value.length === 0) return;
  where.push(`${column} = ?`);
  args.push(value);
}

function addRange(
  where: string[],
  args: (string | number)[],
  column: string,
  minimum: number | undefined,
  maximum: number | undefined,
): void {
  if (minimum !== undefined) {
    where.push(`${column} >= ?`);
    args.push(nonNegativeInteger(minimum, "minimum"));
  }
  if (maximum !== undefined) {
    where.push(`${column} <= ?`);
    args.push(nonNegativeInteger(maximum, "maximum"));
  }
}

function addDateRange(
  where: string[],
  args: (string | number)[],
  column: string,
  after: string | undefined,
  before: string | undefined,
): void {
  if (after !== undefined) {
    where.push(`${column} >= ?`);
    args.push(validDate(after));
  }
  if (before !== undefined) {
    where.push(`${column} <= ?`);
    args.push(validDate(before));
  }
}

function validDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("A date filter is invalid.");
  return date.toISOString();
}
