import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { JobId, LibraryRootId } from "../domain/index.js";
import type {
  FileMutationMode,
  FileMutationModeState,
  OrganizationAuditEvent,
  OrganizationAuditIntegrity,
  OrganizationAuditPage,
  OrganizationOperation,
  OrganizationOperationPage,
  OrganizationPlan,
  OrganizationPlanPage,
  OrganizationRun,
  OrganizationRunItem,
  OrganizationRunItemOutcome,
  OrganizationRunItemPage,
  OrganizationRunMode,
  OrganizationRunPage,
  OrganizationRunStatus,
} from "./organization.js";

interface PlanRow {
  id: string;
  root_id: string;
  root_identity_key: string;
  scan_id: string;
  status: OrganizationPlan["status"];
  options_json: string;
  counts_json: string;
  created_at: string;
  created_by: string;
}

interface OperationRow {
  id: string;
  plan_id: string;
  ordinal: number;
  source_relative_path: string;
  destination_relative_path: string;
  category: string;
  rationale: string;
  expected_json: string;
}

interface RunRow {
  id: string;
  plan_id: string;
  source_run_id: string | null;
  job_id: string | null;
  mode: OrganizationRunMode;
  status: OrganizationRunStatus;
  approved_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface RunItemRow {
  run_id: string;
  operation_id: string;
  outcome: OrganizationRunItemOutcome;
  message: string;
  completed_at: string;
}

interface AuditRow {
  sequence: number;
  id: string;
  event: string;
  occurred_at: string;
  actor: string;
  correlation_id: string;
  previous_hash: string | null;
  entry_hash: string;
  details_json: string;
}

export interface OrganizationStoreOptions {
  readonly databasePath: string;
  readonly busyTimeoutMilliseconds?: number;
  readonly clock?: () => Date;
}

export interface OrganizationPlanListQuery {
  readonly rootId?: LibraryRootId;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OrganizationRunListQuery {
  readonly planId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CreateOrganizationRunInput {
  readonly run: Omit<OrganizationRun, "counts" | "jobId">;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS organization_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_plans (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  root_identity_key TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'archived')),
  options_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS organization_plans_root_created
  ON organization_plans(root_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS organization_operations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES organization_plans(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_relative_path TEXT NOT NULL,
  destination_relative_path TEXT NOT NULL,
  category TEXT NOT NULL,
  rationale TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  UNIQUE (plan_id, ordinal),
  UNIQUE (plan_id, source_relative_path),
  UNIQUE (plan_id, destination_relative_path)
);
CREATE INDEX IF NOT EXISTS organization_operations_plan_ordinal
  ON organization_operations(plan_id, ordinal);

CREATE TABLE IF NOT EXISTS organization_runs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES organization_plans(id),
  source_run_id TEXT REFERENCES organization_runs(id),
  job_id TEXT UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN (
    'simulation', 'live', 'rollback-simulation', 'rollback-live'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'paused', 'completed', 'partial', 'failed', 'cancelled'
  )),
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS organization_runs_plan_created
  ON organization_runs(plan_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS organization_run_items (
  run_id TEXT NOT NULL REFERENCES organization_runs(id),
  operation_id TEXT NOT NULL REFERENCES organization_operations(id),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'simulated', 'moved', 'already-completed', 'would-rollback',
    'rolled-back', 'already-rolled-back', 'skipped', 'failed'
  )),
  message TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, operation_id)
);
CREATE INDEX IF NOT EXISTS organization_run_items_run
  ON organization_run_items(run_id, completed_at, operation_id);

CREATE TABLE IF NOT EXISTS organization_audit (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL UNIQUE,
  details_json TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS organization_audit_reject_update
BEFORE UPDATE ON organization_audit
BEGIN
  SELECT RAISE(ABORT, 'organization audit entries are append-only');
END;
CREATE TRIGGER IF NOT EXISTS organization_audit_reject_delete
BEFORE DELETE ON organization_audit
BEGIN
  SELECT RAISE(ABORT, 'organization audit entries are append-only');
END;
`;

/** Durable plans, execution receipts, safety mode, and a hash-chained audit. */
export class SqliteOrganizationStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;

  public constructor(options: OrganizationStoreOptions) {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#database = new DatabaseSync(options.databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec(
      `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMilliseconds ?? 5_000))}`,
    );
    this.#database.exec(SCHEMA);
    const now = this.#now();
    this.#database.prepare(`INSERT OR IGNORE INTO organization_settings (
      key, value, updated_at, updated_by
    ) VALUES ('file-mutation-mode', 'read-only', ?, 'system-default')`).run(now);
  }

  public close(): void {
    this.#database.close();
  }

  public async mutationMode(): Promise<FileMutationModeState> {
    const row = this.#database.prepare(`SELECT value, updated_at, updated_by
      FROM organization_settings WHERE key = 'file-mutation-mode'`).get() as
      unknown as { value: FileMutationMode; updated_at: string; updated_by: string };
    return { mode: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  public async setMutationMode(
    mode: FileMutationMode,
    updatedBy: string,
    occurredAt = this.#now(),
  ): Promise<FileMutationModeState> {
    return this.#transaction(() => {
      const before = this.#database.prepare(`SELECT value FROM organization_settings
        WHERE key = 'file-mutation-mode'`).get() as unknown as { value: string };
      this.#database.prepare(`UPDATE organization_settings SET
        value = ?, updated_at = ?, updated_by = ?
        WHERE key = 'file-mutation-mode'`).run(mode, occurredAt, updatedBy);
      this.#appendAudit(
        "safety.mutation-mode-changed",
        updatedBy,
        "file-mutation-mode",
        { before: before.value, after: mode },
        occurredAt,
      );
      return { mode, updatedAt: occurredAt, updatedBy };
    });
  }

  public async createPlan(
    plan: OrganizationPlan,
    operations: readonly OrganizationOperation[],
  ): Promise<OrganizationPlan> {
    return this.#transaction(() => {
      if (operations.length !== plan.counts.plannedMoves) {
        throw new Error("The plan operation count does not match its summary.");
      }
      this.#database.prepare(`INSERT INTO organization_plans (
        id, root_id, root_identity_key, scan_id, status, options_json,
        counts_json, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        plan.id,
        plan.rootId,
        plan.rootIdentityKey,
        plan.scanId,
        plan.status,
        JSON.stringify(plan.options),
        JSON.stringify(plan.counts),
        plan.createdAt,
        plan.createdBy,
      );
      const insert = this.#database.prepare(`INSERT INTO organization_operations (
        id, plan_id, ordinal, source_relative_path, destination_relative_path,
        category, rationale, expected_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const operation of operations) {
        if (operation.planId !== plan.id) {
          throw new Error("An organization operation belongs to another plan.");
        }
        insert.run(
          operation.id,
          operation.planId,
          operation.ordinal,
          operation.sourceRelativePath,
          operation.destinationRelativePath,
          operation.category,
          operation.rationale,
          JSON.stringify(operation.expected),
        );
      }
      this.#appendAudit(
        "organization.plan-created",
        plan.createdBy,
        plan.id,
        {
          planId: plan.id,
          rootId: plan.rootId,
          scanId: plan.scanId,
          operationCount: operations.length,
          representedBytes: plan.counts.representedBytes,
          options: plan.options,
        },
        plan.createdAt,
      );
      return plan;
    });
  }

  public async getPlan(id: string): Promise<OrganizationPlan | undefined> {
    const row = this.#database.prepare(`SELECT * FROM organization_plans
      WHERE id = ?`).get(id) as unknown as PlanRow | undefined;
    return row === undefined ? undefined : planFromRow(row);
  }

  public async listPlans(
    query: OrganizationPlanListQuery = {},
  ): Promise<OrganizationPlanPage> {
    const limit = boundedLimit(query.limit, 100, 500);
    const offset = decodeOffsetCursor(query.cursor, "plan");
    const rows = query.rootId === undefined
      ? this.#database.prepare(`SELECT * FROM organization_plans
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(limit + 1, offset) as unknown as PlanRow[]
      : this.#database.prepare(`SELECT * FROM organization_plans
          WHERE root_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(query.rootId, limit + 1, offset) as unknown as PlanRow[];
    return page(rows, limit, offset, planFromRow);
  }

  public async getOperation(id: string): Promise<OrganizationOperation | undefined> {
    const row = this.#database.prepare(`SELECT * FROM organization_operations
      WHERE id = ?`).get(id) as unknown as OperationRow | undefined;
    return row === undefined ? undefined : operationFromRow(row);
  }

  public async listOperations(
    planId: string,
    limit = 200,
    cursor?: string,
  ): Promise<OrganizationOperationPage> {
    const bounded = boundedLimit(limit, 200, 1_000);
    const offset = decodeOffsetCursor(cursor, "operation");
    const rows = this.#database.prepare(`SELECT * FROM organization_operations
      WHERE plan_id = ? ORDER BY ordinal ASC LIMIT ? OFFSET ?`)
      .all(planId, bounded + 1, offset) as unknown as OperationRow[];
    return page(rows, bounded, offset, operationFromRow);
  }

  public async createRun(input: CreateOrganizationRunInput): Promise<OrganizationRun> {
    return this.#transaction(() => {
      const run = input.run;
      const plan = this.#requirePlanRow(run.planId);
      const active = this.#database.prepare(`SELECT id FROM organization_runs
        WHERE plan_id = ? AND status IN ('queued', 'running', 'paused') LIMIT 1`)
        .get(run.planId) as unknown as { id: string } | undefined;
      if (active !== undefined) {
        throw new Error(`Plan ${run.planId} already has an active run.`);
      }
      if (run.mode === "live") {
        const prior = this.#database.prepare(`SELECT id FROM organization_runs
          WHERE plan_id = ? AND mode = 'live' AND status IN ('completed', 'partial')
          LIMIT 1`).get(run.planId) as unknown as { id: string } | undefined;
        if (prior !== undefined) {
          throw new Error("This plan already has a completed live run; create a fresh scan and plan.");
        }
      }
      if (run.mode.startsWith("rollback")) {
        if (run.sourceRunId === undefined) {
          throw new Error("A rollback run requires a source run.");
        }
        const source = this.#requireRunRow(run.sourceRunId);
        if (source.plan_id !== plan.id || source.mode !== "live") {
          throw new Error("Rollback can target only a live run of the same plan.");
        }
      }
      this.#database.prepare(`INSERT INTO organization_runs (
        id, plan_id, source_run_id, mode, status, approved_by, created_at,
        started_at, completed_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        run.id,
        run.planId,
        run.sourceRunId ?? null,
        run.mode,
        run.status,
        run.approvedBy,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.error?.code ?? null,
        run.error?.message ?? null,
      );
      this.#appendAudit(
        "organization.run-created",
        run.approvedBy,
        run.id,
        {
          runId: run.id,
          planId: run.planId,
          mode: run.mode,
          ...(run.sourceRunId === undefined ? {} : { sourceRunId: run.sourceRunId }),
        },
        run.createdAt,
      );
      return this.#runFromRow(this.#requireRunRow(run.id));
    });
  }

  public async attachRunJob(
    runId: string,
    jobId: JobId,
    actor: string,
    occurredAt = this.#now(),
  ): Promise<OrganizationRun> {
    return this.#transaction(() => {
      const result = this.#database.prepare(`UPDATE organization_runs SET job_id = ?
        WHERE id = ? AND job_id IS NULL`).run(jobId, runId);
      if (Number(result.changes) !== 1) {
        const current = this.#requireRunRow(runId);
        if (current.job_id !== jobId) throw new Error("The run is already bound to another job.");
      }
      this.#appendAudit(
        "organization.run-submitted",
        actor,
        runId,
        { runId, jobId },
        occurredAt,
      );
      return this.#runFromRow(this.#requireRunRow(runId));
    });
  }

  public async getRun(id: string): Promise<OrganizationRun | undefined> {
    const row = this.#database.prepare(`SELECT * FROM organization_runs
      WHERE id = ?`).get(id) as unknown as RunRow | undefined;
    return row === undefined ? undefined : this.#runFromRow(row);
  }

  public async listRuns(
    query: OrganizationRunListQuery = {},
  ): Promise<OrganizationRunPage> {
    const limit = boundedLimit(query.limit, 100, 500);
    const offset = decodeOffsetCursor(query.cursor, "run");
    const rows = query.planId === undefined
      ? this.#database.prepare(`SELECT * FROM organization_runs
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(limit + 1, offset) as unknown as RunRow[]
      : this.#database.prepare(`SELECT * FROM organization_runs
          WHERE plan_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(query.planId, limit + 1, offset) as unknown as RunRow[];
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((row) => this.#runFromRow(row)),
      ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + limit) } : {}),
    };
  }

  public async startRun(
    runId: string,
    occurredAt = this.#now(),
  ): Promise<OrganizationRun> {
    return this.#transaction(() => {
      const row = this.#requireRunRow(runId);
      if (["completed", "partial", "failed", "cancelled"].includes(row.status)) {
        return this.#runFromRow(row);
      }
      this.#database.prepare(`UPDATE organization_runs SET
        status = 'running', started_at = COALESCE(started_at, ?),
        completed_at = NULL, error_code = NULL, error_message = NULL
        WHERE id = ?`).run(occurredAt, runId);
      this.#appendAudit(
        "organization.run-started",
        "local-worker",
        runId,
        { runId },
        occurredAt,
      );
      return this.#runFromRow(this.#requireRunRow(runId));
    });
  }

  public async setRunStatus(
    runId: string,
    status: OrganizationRunStatus,
    options: {
      readonly code?: string;
      readonly message?: string;
      readonly actor?: string;
      readonly occurredAt?: string;
    } = {},
  ): Promise<OrganizationRun> {
    return this.#transaction(() => {
      const occurredAt = options.occurredAt ?? this.#now();
      this.#requireRunRow(runId);
      const terminal = ["completed", "partial", "failed", "cancelled"].includes(status);
      this.#database.prepare(`UPDATE organization_runs SET
        status = ?, completed_at = ?, error_code = ?, error_message = ?
        WHERE id = ?`).run(
        status,
        terminal ? occurredAt : null,
        options.code ?? null,
        options.message ?? null,
        runId,
      );
      this.#appendAudit(
        `organization.run-${status}`,
        options.actor ?? "local-worker",
        runId,
        {
          runId,
          status,
          ...(options.code === undefined ? {} : { code: options.code }),
          ...(options.message === undefined ? {} : { message: options.message }),
          counts: this.#runCounts(runId),
        },
        occurredAt,
      );
      return this.#runFromRow(this.#requireRunRow(runId));
    });
  }

  public async recordRunItem(item: OrganizationRunItem): Promise<boolean> {
    return this.#transaction(() => {
      this.#requireRunRow(item.runId);
      const operation = this.#requireOperationRow(item.operationId);
      const run = this.#requireRunRow(item.runId);
      if (operation.plan_id !== run.plan_id) {
        throw new Error("The run item operation belongs to another plan.");
      }
      const result = this.#database.prepare(`INSERT OR IGNORE INTO organization_run_items (
        run_id, operation_id, outcome, message, completed_at
      ) VALUES (?, ?, ?, ?, ?)`).run(
        item.runId,
        item.operationId,
        item.outcome,
        item.message,
        item.completedAt,
      );
      if (Number(result.changes) !== 1) return false;
      this.#appendAudit(
        `organization.operation-${item.outcome}`,
        "local-worker",
        item.runId,
        {
          runId: item.runId,
          operationId: item.operationId,
          source: operation.source_relative_path,
          destination: operation.destination_relative_path,
          outcome: item.outcome,
          message: item.message,
        },
        item.completedAt,
      );
      return true;
    });
  }

  public async getRunItem(
    runId: string,
    operationId: string,
  ): Promise<OrganizationRunItem | undefined> {
    const row = this.#database.prepare(`SELECT * FROM organization_run_items
      WHERE run_id = ? AND operation_id = ?`).get(runId, operationId) as
      unknown as RunItemRow | undefined;
    return row === undefined ? undefined : runItemFromRow(row);
  }

  public async listRunItems(
    runId: string,
    limit = 200,
    cursor?: string,
  ): Promise<OrganizationRunItemPage> {
    const bounded = boundedLimit(limit, 200, 1_000);
    const offset = decodeOffsetCursor(cursor, "run-item");
    const rows = this.#database.prepare(`SELECT
        i.run_id, i.operation_id, i.outcome, i.message, i.completed_at,
        o.id, o.plan_id, o.ordinal, o.source_relative_path,
        o.destination_relative_path, o.category, o.rationale, o.expected_json
      FROM organization_run_items i
      JOIN organization_operations o ON o.id = i.operation_id
      WHERE i.run_id = ? ORDER BY o.ordinal ASC LIMIT ? OFFSET ?`)
      .all(runId, bounded + 1, offset) as unknown as Array<RunItemRow & OperationRow>;
    const hasMore = rows.length > bounded;
    return {
      items: rows.slice(0, bounded).map((row) => ({
        ...runItemFromRow(row),
        operation: operationFromRow(row),
      })),
      ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + bounded) } : {}),
    };
  }

  public async executableOperations(
    run: OrganizationRun,
  ): Promise<readonly OrganizationOperation[]> {
    if (run.sourceRunId === undefined) {
      const rows = this.#database.prepare(`SELECT o.* FROM organization_operations o
        LEFT JOIN organization_run_items i
          ON i.operation_id = o.id AND i.run_id = ?
        WHERE o.plan_id = ? AND i.operation_id IS NULL
        ORDER BY o.ordinal ASC`).all(run.id, run.planId) as unknown as OperationRow[];
      return rows.map(operationFromRow);
    }
    const rows = this.#database.prepare(`SELECT o.* FROM organization_operations o
      JOIN organization_run_items source_item
        ON source_item.operation_id = o.id AND source_item.run_id = ?
      LEFT JOIN organization_run_items rollback_item
        ON rollback_item.operation_id = o.id AND rollback_item.run_id = ?
      WHERE source_item.outcome IN ('moved', 'already-completed')
        AND rollback_item.operation_id IS NULL
      ORDER BY o.ordinal DESC`).all(run.sourceRunId, run.id) as unknown as OperationRow[];
    return rows.map(operationFromRow);
  }

  public async audit(
    limit = 200,
    cursor?: string,
  ): Promise<OrganizationAuditPage> {
    const bounded = boundedLimit(limit, 200, 1_000);
    const offset = decodeOffsetCursor(cursor, "audit");
    const rows = this.#database.prepare(`SELECT * FROM organization_audit
      ORDER BY sequence DESC LIMIT ? OFFSET ?`).all(bounded + 1, offset) as
      unknown as AuditRow[];
    const hasMore = rows.length > bounded;
    return {
      items: rows.slice(0, bounded).map(auditFromRow),
      ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + bounded) } : {}),
    };
  }

  public async verifyAuditIntegrity(): Promise<OrganizationAuditIntegrity> {
    const rows = this.#database.prepare(`SELECT * FROM organization_audit
      ORDER BY sequence ASC`).all() as unknown as AuditRow[];
    let previousHash: string | undefined;
    let expectedSequence = 1;
    for (const row of rows) {
      if (row.sequence !== expectedSequence) {
        return {
          valid: false,
          entriesChecked: expectedSequence - 1,
          firstInvalidSequence: row.sequence,
          reason: "The audit sequence is not contiguous.",
        };
      }
      if ((row.previous_hash ?? undefined) !== previousHash) {
        return {
          valid: false,
          entriesChecked: expectedSequence - 1,
          firstInvalidSequence: row.sequence,
          reason: "The audit hash chain does not reference the previous entry.",
        };
      }
      const expectedHash = auditHash(row, row.details_json);
      if (expectedHash !== row.entry_hash) {
        return {
          valid: false,
          entriesChecked: expectedSequence - 1,
          firstInvalidSequence: row.sequence,
          reason: "An audit entry hash is invalid.",
        };
      }
      previousHash = row.entry_hash;
      expectedSequence += 1;
    }
    return { valid: true, entriesChecked: rows.length };
  }

  #appendAudit(
    event: string,
    actor: string,
    correlationId: string,
    details: Readonly<Record<string, unknown>>,
    occurredAt: string,
  ): void {
    const prior = this.#database.prepare(`SELECT sequence, entry_hash
      FROM organization_audit ORDER BY sequence DESC LIMIT 1`).get() as unknown as
      { sequence: number; entry_hash: string } | undefined;
    const sequence = (prior?.sequence ?? 0) + 1;
    const id = `audit_${randomUUID()}`;
    const detailsJson = JSON.stringify(details);
    const row: AuditRow = {
      sequence,
      id,
      event,
      occurred_at: occurredAt,
      actor,
      correlation_id: correlationId,
      previous_hash: prior?.entry_hash ?? null,
      entry_hash: "",
      details_json: detailsJson,
    };
    const hash = auditHash(row, detailsJson);
    this.#database.prepare(`INSERT INTO organization_audit (
      sequence, id, event, occurred_at, actor, correlation_id, previous_hash,
      entry_hash, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sequence,
      id,
      event,
      occurredAt,
      actor,
      correlationId,
      row.previous_hash,
      hash,
      detailsJson,
    );
  }

  #runFromRow(row: RunRow): OrganizationRun {
    return {
      id: row.id,
      planId: row.plan_id,
      ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
      ...(row.job_id === null ? {} : { jobId: row.job_id as JobId }),
      mode: row.mode,
      status: row.status,
      approvedBy: row.approved_by,
      createdAt: row.created_at,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.error_code === null
        ? {}
        : { error: { code: row.error_code, message: row.error_message ?? "Run failed." } }),
      counts: this.#runCounts(row.id),
    };
  }

  #runCounts(runId: string): OrganizationRun["counts"] {
    const run = this.#requireRunRow(runId);
    const planCount = this.#database.prepare(`SELECT COUNT(*) AS count
      FROM organization_operations WHERE plan_id = ?`).get(run.plan_id) as
      unknown as { count: number };
    const rollbackCount = run.source_run_id === null
      ? undefined
      : this.#database.prepare(`SELECT COUNT(*) AS count
          FROM organization_run_items WHERE run_id = ?
          AND outcome IN ('moved', 'already-completed')`).get(run.source_run_id) as
          unknown as { count: number };
    const values = this.#database.prepare(`SELECT
        COUNT(*) AS processed,
        SUM(CASE WHEN outcome IN (
          'simulated', 'moved', 'already-completed', 'would-rollback',
          'rolled-back', 'already-rolled-back'
        ) THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM organization_run_items WHERE run_id = ?`).get(runId) as unknown as {
        processed: number;
        succeeded: number | null;
        skipped: number | null;
        failed: number | null;
      };
    return {
      total: Number(rollbackCount?.count ?? planCount.count),
      processed: Number(values.processed),
      succeeded: Number(values.succeeded ?? 0),
      skipped: Number(values.skipped ?? 0),
      failed: Number(values.failed ?? 0),
    };
  }

  #requirePlanRow(id: string): PlanRow {
    const row = this.#database.prepare(`SELECT * FROM organization_plans
      WHERE id = ?`).get(id) as unknown as PlanRow | undefined;
    if (row === undefined) throw new Error(`Organization plan ${id} does not exist.`);
    return row;
  }

  #requireOperationRow(id: string): OperationRow {
    const row = this.#database.prepare(`SELECT * FROM organization_operations
      WHERE id = ?`).get(id) as unknown as OperationRow | undefined;
    if (row === undefined) throw new Error(`Organization operation ${id} does not exist.`);
    return row;
  }

  #requireRunRow(id: string): RunRow {
    const row = this.#database.prepare(`SELECT * FROM organization_runs
      WHERE id = ?`).get(id) as unknown as RunRow | undefined;
    if (row === undefined) throw new Error(`Organization run ${id} does not exist.`);
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

  #now(): string {
    return this.#clock().toISOString();
  }
}

function planFromRow(row: PlanRow): OrganizationPlan {
  return {
    id: row.id,
    rootId: row.root_id as OrganizationPlan["rootId"],
    rootIdentityKey: row.root_identity_key,
    scanId: row.scan_id as OrganizationPlan["scanId"],
    status: row.status,
    options: JSON.parse(row.options_json) as OrganizationPlan["options"],
    counts: JSON.parse(row.counts_json) as OrganizationPlan["counts"],
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function operationFromRow(row: OperationRow): OrganizationOperation {
  return {
    id: row.id,
    planId: row.plan_id,
    ordinal: Number(row.ordinal),
    sourceRelativePath: row.source_relative_path as OrganizationOperation["sourceRelativePath"],
    destinationRelativePath: row.destination_relative_path as OrganizationOperation["destinationRelativePath"],
    category: row.category,
    rationale: row.rationale,
    expected: JSON.parse(row.expected_json) as OrganizationOperation["expected"],
  };
}

function runItemFromRow(row: RunItemRow): OrganizationRunItem {
  return {
    runId: row.run_id,
    operationId: row.operation_id,
    outcome: row.outcome,
    message: row.message,
    completedAt: row.completed_at,
  };
}

function auditFromRow(row: AuditRow): OrganizationAuditEvent {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    event: row.event,
    occurredAt: row.occurred_at,
    actor: row.actor,
    correlationId: row.correlation_id,
    ...(row.previous_hash === null ? {} : { previousHash: row.previous_hash }),
    entryHash: row.entry_hash,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
  };
}

function auditHash(row: AuditRow, detailsJson: string): string {
  return createHash("sha256").update(JSON.stringify([
    row.sequence,
    row.id,
    row.event,
    row.occurred_at,
    row.actor,
    row.correlation_id,
    row.previous_hash,
    detailsJson,
  ]), "utf8").digest("hex");
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function page<Row, Value>(
  rows: readonly Row[],
  limit: number,
  offset: number,
  convert: (row: Row) => Value,
): { readonly items: readonly Value[]; readonly nextCursor?: string } {
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(convert),
    ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + limit) } : {}),
  };
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor: string | undefined, kind: string): number {
  if (cursor === undefined) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The organization ${kind} cursor is invalid.`);
  }
  return value;
}
