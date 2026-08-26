import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  JobEventId,
  JobId,
  JobLeaseId,
  JsonObject,
  JsonValue,
  WorkerId,
} from "../domain/index.js";
import type {
  JobClient,
  JobLease,
  JobRecoveryReport,
  PersistentJobQueue,
  WorkerControlSignal,
} from "./job-queue.js";
import type {
  JobDefinition,
  JobHistoryEvent,
  JobHistoryPage,
  JobKind,
  JobProgress,
  JobRecoveryMode,
  JobResultView,
  JobStatus,
  JobStatusView,
  JobSubmission,
  JobSubmissionReceipt,
  PersistentJobRecord,
  StructuredJobError,
  StructuredJobResult,
} from "./job.js";
import type {
  JobListQuery,
  JobRecordPage,
  PersistentJobStore,
} from "./job-store.js";

type SqliteValue = string | number | bigint | Uint8Array | null;

interface JobRow {
  id: string;
  revision: number;
  kind: string;
  recovery_mode: JobRecoveryMode;
  status: JobStatus;
  payload_json: string;
  priority: number;
  idempotency_key: string;
  requested_by: string;
  control_policy_json: string;
  progress_json: string | null;
  checkpoint_json: string | null;
  result_json: string | null;
  error_json: string | null;
  attempts_json: string;
  lease_id: string | null;
  lease_worker_id: string | null;
  lease_expires_at: number | null;
  pause_requested: number;
  cancel_requested: number;
  submitted_at: string;
  updated_at: string;
}

interface HistoryRow {
  job_id: string;
  sequence: number;
  id: string;
  kind: JobHistoryEvent["kind"];
  from_status: JobStatus | null;
  to_status: JobStatus;
  worker_id: string | null;
  details_json: string;
  occurred_at: string;
}

export interface SqliteJobQueueOptions {
  readonly databasePath: string;
  readonly definitions: readonly JobDefinition[];
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export class UnknownJobKindError extends Error {
  public constructor(kind: JobKind) {
    super(`No enabled job definition exists for ${kind}.`);
    this.name = "UnknownJobKindError";
  }
}

export class IdempotencyConflictError extends Error {
  public constructor(key: string) {
    super(`Idempotency key ${key} was already used for different work.`);
    this.name = "IdempotencyConflictError";
  }
}

export class JobNotFoundError extends Error {
  public constructor(jobId: JobId) {
    super(`Job ${jobId} does not exist.`);
    this.name = "JobNotFoundError";
  }
}

export class InvalidJobControlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidJobControlError";
  }
}

export class StaleJobLeaseError extends Error {
  public constructor(jobId: JobId) {
    super(`The lease for job ${jobId} is missing, expired, or no longer current.`);
    this.name = "StaleJobLeaseError";
  }
}

const RUNTIME_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  kind TEXT NOT NULL,
  recovery_mode TEXT NOT NULL CHECK (recovery_mode IN ('restart', 'resume-from-checkpoint')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  control_policy_json TEXT NOT NULL,
  progress_json TEXT,
  checkpoint_json TEXT,
  result_json TEXT,
  error_json TEXT,
  attempts_json TEXT NOT NULL,
  lease_id TEXT,
  lease_worker_id TEXT,
  lease_expires_at INTEGER,
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0, 1)),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status_priority
  ON jobs(status, priority DESC, submitted_at ASC);
CREATE TABLE IF NOT EXISTS job_history (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  sequence INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  worker_id TEXT,
  details_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (job_id, sequence)
);
CREATE TRIGGER IF NOT EXISTS job_history_reject_update
BEFORE UPDATE ON job_history BEGIN
  SELECT RAISE(ABORT, 'job history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS job_history_reject_delete
BEFORE DELETE ON job_history BEGIN
  SELECT RAISE(ABORT, 'job history is append-only');
END;
`;

/**
 * SQLite-backed queue shared by short-lived submitters and independent local
 * workers. Every state transition and its audit event commit together.
 */
export class SqlitePersistentJobQueue
  implements PersistentJobQueue, PersistentJobStore
{
  readonly #database: DatabaseSync;
  readonly #definitions: ReadonlyMap<JobKind, JobDefinition>;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;

  public constructor(options: SqliteJobQueueOptions) {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }

    this.#database = new DatabaseSync(options.databasePath);
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;

    const definitions = new Map<JobKind, JobDefinition>();
    for (const definition of options.definitions) {
      if (definitions.has(definition.kind)) {
        throw new Error(`Duplicate job definition: ${definition.kind}`);
      }
      definitions.set(definition.kind, definition);
    }
    this.#definitions = definitions;

    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA busy_timeout = 15000");
    this.#database.exec("PRAGMA wal_autocheckpoint = 1000");
    this.#database.exec(RUNTIME_SCHEMA);
  }

  public close(): void {
    this.#database.close();
  }

  public async submit(submission: JobSubmission): Promise<JobSubmissionReceipt> {
    const definition = this.#definition(submission.kind);
    validateSubmission(submission);
    definition.validatePayload(submission.payload);
    const payloadJson = stableStringify(submission.payload);

    return this.#transaction(() => {
      const existing = this.#getRowByIdempotencyKey(submission.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.kind !== submission.kind ||
          stableStringify(parseJsonObject(existing.payload_json)) !== payloadJson
        ) {
          throw new IdempotencyConflictError(submission.idempotencyKey);
        }
        return {
          jobId: existing.id as JobId,
          status: existing.status,
          submittedAt: existing.submitted_at,
          deduplicatedSubmission: true,
        };
      }

      const now = this.#nowIso();
      const jobId = this.#newId("job") as JobId;
      this.#database
        .prepare(`INSERT INTO jobs (
          id, revision, kind, recovery_mode, status, payload_json, priority,
          idempotency_key, requested_by, control_policy_json, attempts_json,
          submitted_at, updated_at
        ) VALUES (?, 0, ?, ?, 'queued', ?, ?, ?, ?, ?, '[]', ?, ?)`)
        .run(
          jobId,
          submission.kind,
          definition.recoveryMode,
          payloadJson,
          submission.priority,
          submission.idempotencyKey,
          submission.requestedBy,
          JSON.stringify(submission.controlPolicy),
          now,
          now,
        );
      this.#appendEvent(jobId, "submitted", undefined, "queued", undefined, {
        requestedBy: submission.requestedBy,
        kind: submission.kind,
      }, now);

      return {
        jobId,
        status: "queued",
        submittedAt: now,
        deduplicatedSubmission: false,
      };
    });
  }

  public async status(jobId: JobId): Promise<JobStatusView | undefined> {
    const row = this.#getRow(jobId);
    return row === undefined ? undefined : statusView(row);
  }

  public async result(jobId: JobId): Promise<JobResultView | undefined> {
    const row = this.#getRow(jobId);
    if (row === undefined) return undefined;
    return {
      jobId,
      status: row.status,
      ...(row.result_json === null
        ? {}
        : { result: parseJson<StructuredJobResult>(row.result_json) }),
      ...(row.error_json === null
        ? {}
        : { error: parseJson<StructuredJobError>(row.error_json) }),
    };
  }

  public async history(
    jobId: JobId,
    afterSequence = 0,
    limit = 100,
  ): Promise<JobHistoryPage> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.#database
      .prepare(`SELECT * FROM job_history
        WHERE job_id = ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?`)
      .all(jobId, afterSequence, safeLimit + 1) as unknown as HistoryRow[];
    const hasMore = rows.length > safeLimit;
    const visible = hasMore ? rows.slice(0, safeLimit) : rows;
    const last = visible.at(-1);
    return {
      events: visible.map(historyFromRow),
      ...(hasMore && last !== undefined
        ? { nextSequence: last.sequence }
        : {}),
    };
  }

  public async requestPause(
    jobId: JobId,
    requestedBy: string,
  ): Promise<JobStatusView> {
    return this.#transaction(() => {
      const row = this.#requireRow(jobId);
      const policy = parseJson<PersistentJobRecord["controlPolicy"]>(
        row.control_policy_json,
      );
      if (policy.pauseMode === "not-supported") {
        throw new InvalidJobControlError(`Job ${jobId} does not support pause.`);
      }
      if (row.status === "paused" || row.pause_requested === 1) {
        return statusView(row);
      }
      if (row.status !== "queued" && row.status !== "running") {
        throw new InvalidJobControlError(
          `Cannot pause job ${jobId} while it is ${row.status}.`,
        );
      }
      const now = this.#nowIso();
      const nextStatus: JobStatus = row.status === "queued" ? "paused" : "running";
      this.#database.prepare(`UPDATE jobs SET
        status = ?, pause_requested = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?`).run(
          nextStatus,
          row.status === "running" ? 1 : 0,
          now,
          jobId,
        );
      this.#appendEvent(
        jobId,
        "pause-requested",
        row.status,
        nextStatus,
        row.lease_worker_id as WorkerId | null,
        { requestedBy },
        now,
      );
      if (row.status === "queued") {
        this.#appendEvent(jobId, "paused", "queued", "paused", undefined, {}, now);
      }
      return statusView(this.#requireRow(jobId));
    });
  }

  public async resume(jobId: JobId, requestedBy: string): Promise<JobStatusView> {
    return this.#transaction(() => {
      const row = this.#requireRow(jobId);
      if (row.status === "queued") return statusView(row);
      if (row.status !== "paused") {
        throw new InvalidJobControlError(
          `Cannot resume job ${jobId} while it is ${row.status}.`,
        );
      }
      const now = this.#nowIso();
      this.#database.prepare(`UPDATE jobs SET
        status = 'queued', pause_requested = 0, revision = revision + 1,
        updated_at = ? WHERE id = ?`).run(now, jobId);
      this.#appendEvent(
        jobId,
        "resume-requested",
        "paused",
        "queued",
        undefined,
        { requestedBy },
        now,
      );
      return statusView(this.#requireRow(jobId));
    });
  }

  public async cancel(jobId: JobId, requestedBy: string): Promise<JobStatusView> {
    return this.#transaction(() => {
      const row = this.#requireRow(jobId);
      if (row.status === "cancelled") return statusView(row);
      if (row.status === "completed" || row.status === "failed") {
        throw new InvalidJobControlError(
          `Cannot cancel job ${jobId} while it is ${row.status}.`,
        );
      }
      const now = this.#nowIso();
      if (row.status === "running") {
        this.#database.prepare(`UPDATE jobs SET
          cancel_requested = 1, revision = revision + 1, updated_at = ?
          WHERE id = ?`).run(now, jobId);
        this.#appendEvent(
          jobId,
          "cancel-requested",
          "running",
          "running",
          row.lease_worker_id as WorkerId | null,
          { requestedBy },
          now,
        );
      } else {
        this.#database.prepare(`UPDATE jobs SET
          status = 'cancelled', cancel_requested = 0, pause_requested = 0,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, jobId);
        this.#appendEvent(
          jobId,
          "cancel-requested",
          row.status,
          row.status,
          undefined,
          { requestedBy },
          now,
        );
        this.#appendEvent(jobId, "cancelled", row.status, "cancelled", undefined, {}, now);
      }
      return statusView(this.#requireRow(jobId));
    });
  }

  public async claimNext(
    workerId: WorkerId,
    supportedKinds?: readonly JobKind[],
  ): Promise<JobLease | undefined> {
    const kinds = supportedKinds ?? [...this.#definitions.keys()];
    if (kinds.length === 0) return undefined;
    for (const kind of kinds) this.#definition(kind);

    return this.#transaction(() => {
      const placeholders = kinds.map(() => "?").join(", ");
      const row = this.#database
        .prepare(`SELECT * FROM jobs WHERE status = 'queued'
          AND kind IN (${placeholders})
          ORDER BY priority DESC, submitted_at ASC, id ASC LIMIT 1`)
        .get(...(kinds as readonly SqliteValue[])) as unknown as JobRow | undefined;
      if (row === undefined) return undefined;

      const policy = parseJson<PersistentJobRecord["controlPolicy"]>(
        row.control_policy_json,
      );
      const nowDate = this.#clock();
      const now = nowDate.toISOString();
      const leaseId = this.#newId("lease") as JobLeaseId;
      const expiresAtMs = nowDate.getTime() + policy.leaseDurationMilliseconds;
      const attempts = parseJson<PersistentJobRecord["attempts"]>(row.attempts_json);
      const attempt = attempts.length + 1;
      const nextAttempts = [
        ...attempts,
        { attempt, workerId, startedAt: now },
      ];
      this.#database.prepare(`UPDATE jobs SET
        status = 'running', attempts_json = ?, lease_id = ?,
        lease_worker_id = ?, lease_expires_at = ?, revision = revision + 1,
        updated_at = ? WHERE id = ? AND status = 'queued'`).run(
          JSON.stringify(nextAttempts),
          leaseId,
          workerId,
          expiresAtMs,
          now,
          row.id,
        );
      this.#appendEvent(
        row.id as JobId,
        "claimed",
        "queued",
        "running",
        workerId,
        { attempt, leaseId, expiresAt: new Date(expiresAtMs).toISOString() },
        now,
      );
      return {
        id: leaseId,
        jobId: row.id as JobId,
        workerId,
        attempt,
        acquiredAt: now,
        expiresAt: new Date(expiresAtMs).toISOString(),
        ...(row.checkpoint_json === null
          ? {}
          : { checkpoint: parseJsonObject(row.checkpoint_json) }),
      };
    });
  }

  public async loadLeasedJob(lease: JobLease): Promise<PersistentJobRecord> {
    const row = this.#requireCurrentLease(lease);
    return recordFromRow(row);
  }

  public async heartbeat(
    lease: JobLease,
    progress?: JobProgress,
  ): Promise<JobLease> {
    return this.#transaction(() => {
      const row = this.#requireCurrentLease(lease);
      const policy = parseJson<PersistentJobRecord["controlPolicy"]>(
        row.control_policy_json,
      );
      const nowDate = this.#clock();
      const now = nowDate.toISOString();
      const expiresAtMs = nowDate.getTime() + policy.leaseDurationMilliseconds;
      this.#database.prepare(`UPDATE jobs SET
        lease_expires_at = ?, progress_json = COALESCE(?, progress_json),
        revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          expiresAtMs,
          progress === undefined ? null : JSON.stringify(progress),
          now,
          lease.jobId,
        );
      if (progress !== undefined) {
        this.#appendEvent(
          lease.jobId,
          "progress-reported",
          "running",
          "running",
          lease.workerId,
          { phase: progress.phase, completedUnits: progress.completedUnits },
          now,
        );
      }
      return {
        ...lease,
        expiresAt: new Date(expiresAtMs).toISOString(),
        ...(row.checkpoint_json === null
          ? {}
          : { checkpoint: parseJsonObject(row.checkpoint_json) }),
      };
    });
  }

  public async saveCheckpoint(
    lease: JobLease,
    checkpoint: JsonObject,
  ): Promise<void> {
    this.#transaction(() => {
      this.#requireCurrentLease(lease);
      const now = this.#nowIso();
      this.#database.prepare(`UPDATE jobs SET checkpoint_json = ?,
        revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          JSON.stringify(checkpoint),
          now,
          lease.jobId,
        );
      this.#appendEvent(
        lease.jobId,
        "checkpoint-saved",
        "running",
        "running",
        lease.workerId,
        {},
        now,
      );
    });
  }

  public async complete(
    lease: JobLease,
    result: StructuredJobResult,
  ): Promise<void> {
    this.#finishLease(lease, "completed", result, undefined);
  }

  public async fail(lease: JobLease, error: StructuredJobError): Promise<void> {
    this.#transaction(() => {
      const row = this.#requireCurrentLease(lease);
      const attempts = finishAttempt(row, lease, "failed", error, this.#nowIso());
      const policy = parseJson<PersistentJobRecord["controlPolicy"]>(
        row.control_policy_json,
      );
      const failureCount = retryConsumingAttempts(attempts);
      const retry = error.retryable && failureCount < policy.maximumAttempts;
      const now = this.#nowIso();
      this.#database.prepare(`UPDATE jobs SET
        status = ?, attempts_json = ?, error_json = ?, lease_id = NULL,
        lease_worker_id = NULL, lease_expires_at = NULL,
        pause_requested = 0, cancel_requested = 0,
        checkpoint_json = CASE WHEN ? = 'restart' THEN NULL ELSE checkpoint_json END,
        progress_json = CASE WHEN ? = 'restart' THEN NULL ELSE progress_json END,
        revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          retry ? "queued" : "failed",
          JSON.stringify(attempts),
          JSON.stringify(error),
          row.recovery_mode,
          row.recovery_mode,
          now,
          lease.jobId,
        );
      this.#appendEvent(
        lease.jobId,
        "failed",
        "running",
        retry ? "queued" : "failed",
        lease.workerId,
        { code: error.code, retry, attempt: lease.attempt },
        now,
      );
    });
  }

  public async acknowledgePaused(
    lease: JobLease,
    checkpoint?: JsonObject,
  ): Promise<void> {
    this.#transaction(() => {
      const row = this.#requireCurrentLease(lease);
      if (row.pause_requested !== 1) {
        throw new InvalidJobControlError(`Pause was not requested for ${lease.jobId}.`);
      }
      const now = this.#nowIso();
      const attempts = finishAttempt(row, lease, "paused", undefined, now);
      this.#database.prepare(`UPDATE jobs SET
        status = 'paused', checkpoint_json = ?, attempts_json = ?,
        lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
        pause_requested = 0, revision = revision + 1, updated_at = ?
        WHERE id = ?`).run(optionalJson(checkpoint), JSON.stringify(attempts), now, lease.jobId);
      this.#appendEvent(
        lease.jobId,
        "paused",
        "running",
        "paused",
        lease.workerId,
        { attempt: lease.attempt },
        now,
      );
    });
  }

  public async acknowledgeCancelled(
    lease: JobLease,
    details: JsonObject,
  ): Promise<void> {
    this.#transaction(() => {
      const row = this.#requireCurrentLease(lease);
      if (row.cancel_requested !== 1) {
        throw new InvalidJobControlError(`Cancellation was not requested for ${lease.jobId}.`);
      }
      const now = this.#nowIso();
      const attempts = finishAttempt(row, lease, "cancelled", undefined, now);
      this.#database.prepare(`UPDATE jobs SET
        status = 'cancelled', attempts_json = ?, lease_id = NULL,
        lease_worker_id = NULL, lease_expires_at = NULL,
        pause_requested = 0, cancel_requested = 0,
        revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          JSON.stringify(attempts),
          now,
          lease.jobId,
        );
      this.#appendEvent(
        lease.jobId,
        "cancelled",
        "running",
        "cancelled",
        lease.workerId,
        details,
        now,
      );
    });
  }

  public async controlSignal(lease: JobLease): Promise<WorkerControlSignal> {
    const row = this.#requireCurrentLease(lease);
    if (row.cancel_requested === 1) return "cancel";
    if (row.pause_requested === 1) return "pause";
    return "continue";
  }

  public async recoverExpiredLeases(now: string): Promise<JobRecoveryReport> {
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Recovery time must be a valid ISO timestamp.");
    return this.#transaction(() => {
      const rows = this.#database
        .prepare(`SELECT * FROM jobs WHERE status = 'running'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`)
        .all(nowMs) as unknown as JobRow[];
      const requeued: JobId[] = [];
      const failed: JobId[] = [];

      for (const row of rows) {
        const jobId = row.id as JobId;
        const workerId = row.lease_worker_id as WorkerId;
        const lease: JobLease = {
          id: row.lease_id as JobLeaseId,
          jobId,
          workerId,
          attempt: parseJson<PersistentJobRecord["attempts"]>(row.attempts_json).length,
          acquiredAt: now,
          expiresAt: new Date(row.lease_expires_at ?? nowMs).toISOString(),
        };
        const error: StructuredJobError = {
          code: "LEASE_EXPIRED",
          message: "The worker lease expired before the job reached a terminal state.",
          retryable: true,
          details: {},
          occurredAt: now,
        };
        const attempts = finishAttempt(row, lease, "lease-expired", error, now);
        const policy = parseJson<PersistentJobRecord["controlPolicy"]>(
          row.control_policy_json,
        );
        const exhausted = retryConsumingAttempts(attempts) >= policy.maximumAttempts;
        this.#appendEvent(
          jobId,
          "lease-expired",
          "running",
          "running",
          workerId,
          { attempt: lease.attempt },
          now,
        );

        let status: JobStatus;
        if (row.cancel_requested === 1) status = "cancelled";
        else if (row.pause_requested === 1) status = "paused";
        else if (exhausted) status = "failed";
        else status = "queued";

        this.#database.prepare(`UPDATE jobs SET
          status = ?, attempts_json = ?, error_json = ?, lease_id = NULL,
          lease_worker_id = NULL, lease_expires_at = NULL,
          pause_requested = 0, cancel_requested = 0,
          checkpoint_json = CASE WHEN ? = 'restart' THEN NULL ELSE checkpoint_json END,
          progress_json = CASE WHEN ? = 'restart' THEN NULL ELSE progress_json END,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(
            status,
            JSON.stringify(attempts),
            JSON.stringify(error),
            row.recovery_mode,
            row.recovery_mode,
            now,
            jobId,
          );

        if (status === "queued") {
          requeued.push(jobId);
          this.#appendEvent(
            jobId,
            "requeued-after-recovery",
            "running",
            "queued",
            undefined,
            { recoveryMode: row.recovery_mode },
            now,
          );
        } else if (status === "failed") {
          failed.push(jobId);
          this.#appendEvent(jobId, "failed", "running", "failed", undefined, {
            code: error.code,
            retry: false,
          }, now);
        } else if (status === "paused") {
          this.#appendEvent(jobId, "paused", "running", "paused", undefined, {
            recoveredAfterLeaseExpiry: true,
          }, now);
        } else {
          this.#appendEvent(jobId, "cancelled", "running", "cancelled", undefined, {
            recoveredAfterLeaseExpiry: true,
          }, now);
        }
      }
      return {
        checkedAt: now,
        expiredLeaseCount: rows.length,
        requeuedJobIds: requeued,
        failedJobIds: failed,
      };
    });
  }

  public async create(
    record: PersistentJobRecord,
    initialEvent: JobHistoryEvent,
  ): Promise<void> {
    this.#transaction(() => {
      const definition = this.#definition(record.kind);
      definition.validatePayload(record.payload);
      this.#insertRecord(record, definition.recoveryMode);
      this.#insertEvent(initialEvent);
    });
  }

  public async get(jobId: JobId): Promise<PersistentJobRecord | undefined> {
    const row = this.#getRow(jobId);
    return row === undefined ? undefined : recordFromRow(row);
  }

  public async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PersistentJobRecord | undefined> {
    const row = this.#getRowByIdempotencyKey(idempotencyKey);
    return row === undefined ? undefined : recordFromRow(row);
  }

  public async update(
    expectedRevision: number,
    record: PersistentJobRecord,
    event: JobHistoryEvent,
  ): Promise<boolean> {
    return this.#transaction(() => {
      const current = this.#getRow(record.id);
      if (current === undefined || current.revision !== expectedRevision) return false;
      const result = this.#database.prepare(`UPDATE jobs SET
        revision = ?, kind = ?, status = ?, payload_json = ?, priority = ?,
        idempotency_key = ?, requested_by = ?, control_policy_json = ?,
        progress_json = ?, checkpoint_json = ?, result_json = ?, error_json = ?,
        attempts_json = ?, submitted_at = ?, updated_at = ?
        WHERE id = ? AND revision = ?`).run(
          record.revision,
          record.kind,
          record.status,
          JSON.stringify(record.payload),
          record.priority,
          record.idempotencyKey,
          record.requestedBy,
          JSON.stringify(record.controlPolicy),
          optionalJson(record.progress),
          optionalJson(record.checkpoint),
          optionalJson(record.result),
          optionalJson(record.error),
          JSON.stringify(record.attempts),
          record.submittedAt,
          record.updatedAt,
          record.id,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) return false;
      this.#insertEvent(event);
      return true;
    });
  }

  public async *streamHistory(jobId: JobId): AsyncIterable<JobHistoryEvent> {
    let after = 0;
    while (true) {
      const page = await this.history(jobId, after, 500);
      for (const event of page.events) yield event;
      if (page.nextSequence === undefined) return;
      after = page.nextSequence;
    }
  }

  public async list(query: JobListQuery = {}): Promise<JobRecordPage> {
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
    const statuses = query.statuses ?? [];
    const where = statuses.length === 0
      ? ""
      : `WHERE status IN (${statuses.map(() => "?").join(", ")})`;
    const rows = this.#database
      .prepare(`SELECT * FROM jobs ${where}
        ORDER BY submitted_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...(statuses as readonly SqliteValue[]), limit + 1, offset) as unknown as JobRow[];
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map(recordFromRow),
      ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  #finishLease(
    lease: JobLease,
    status: "completed",
    result: StructuredJobResult,
    error: undefined,
  ): void {
    this.#transaction(() => {
      const row = this.#requireCurrentLease(lease);
      const now = this.#nowIso();
      const attempts = finishAttempt(row, lease, status, error, now);
      this.#database.prepare(`UPDATE jobs SET
        status = 'completed', result_json = ?, error_json = NULL,
        attempts_json = ?, lease_id = NULL, lease_worker_id = NULL,
        lease_expires_at = NULL, pause_requested = 0, cancel_requested = 0,
        revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          JSON.stringify(result),
          JSON.stringify(attempts),
          now,
          lease.jobId,
        );
      this.#appendEvent(
        lease.jobId,
        "completed",
        "running",
        "completed",
        lease.workerId,
        { attempt: lease.attempt },
        now,
      );
    });
  }

  #definition(kind: JobKind): JobDefinition {
    const definition = this.#definitions.get(kind);
    if (definition === undefined) throw new UnknownJobKindError(kind);
    return definition;
  }

  #requireCurrentLease(lease: JobLease): JobRow {
    const row = this.#requireRow(lease.jobId);
    if (
      row.status !== "running" ||
      row.lease_id !== lease.id ||
      row.lease_worker_id !== lease.workerId ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= this.#clock().getTime()
    ) {
      throw new StaleJobLeaseError(lease.jobId);
    }
    return row;
  }

  #getRow(jobId: JobId): JobRow | undefined {
    return this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
      | unknown as JobRow
      | undefined;
  }

  #requireRow(jobId: JobId): JobRow {
    const row = this.#getRow(jobId);
    if (row === undefined) throw new JobNotFoundError(jobId);
    return row;
  }

  #getRowByIdempotencyKey(key: string): JobRow | undefined {
    return this.#database
      .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
      .get(key) as unknown as JobRow | undefined;
  }

  #appendEvent(
    jobId: JobId,
    kind: JobHistoryEvent["kind"],
    fromStatus: JobStatus | undefined,
    toStatus: JobStatus,
    workerId: WorkerId | null | undefined,
    details: JsonObject,
    occurredAt: string,
  ): void {
    const sequenceRow = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_history WHERE job_id = ?")
      .get(jobId) as unknown as { sequence: number };
    this.#database.prepare(`INSERT INTO job_history (
      job_id, sequence, id, kind, from_status, to_status, worker_id,
      details_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      jobId,
      sequenceRow.sequence,
      this.#newId("event"),
      kind,
      fromStatus ?? null,
      toStatus,
      workerId ?? null,
      JSON.stringify(details),
      occurredAt,
    );
  }

  #insertEvent(event: JobHistoryEvent): void {
    this.#database.prepare(`INSERT INTO job_history (
      job_id, sequence, id, kind, from_status, to_status, worker_id,
      details_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.jobId,
      event.sequence,
      event.id,
      event.kind,
      event.fromStatus ?? null,
      event.toStatus,
      event.workerId ?? null,
      JSON.stringify(event.details),
      event.occurredAt,
    );
  }

  #insertRecord(record: PersistentJobRecord, recoveryMode: JobRecoveryMode): void {
    this.#database.prepare(`INSERT INTO jobs (
      id, revision, kind, recovery_mode, status, payload_json, priority,
      idempotency_key, requested_by, control_policy_json, progress_json,
      checkpoint_json, result_json, error_json, attempts_json, submitted_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id,
      record.revision,
      record.kind,
      recoveryMode,
      record.status,
      JSON.stringify(record.payload),
      record.priority,
      record.idempotencyKey,
      record.requestedBy,
      JSON.stringify(record.controlPolicy),
      optionalJson(record.progress),
      optionalJson(record.checkpoint),
      optionalJson(record.result),
      optionalJson(record.error),
      JSON.stringify(record.attempts),
      record.submittedAt,
      record.updatedAt,
    );
  }

  #newId(prefix: string): string {
    return `${prefix}_${this.#idFactory()}`;
  }

  #nowIso(): string {
    return this.#clock().toISOString();
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

function validateSubmission(submission: JobSubmission): void {
  if (!submission.idempotencyKey.trim()) throw new Error("An idempotency key is required.");
  if (!submission.requestedBy.trim()) throw new Error("requestedBy is required.");
  if (!Number.isInteger(submission.priority)) throw new Error("priority must be an integer.");
  if (!Number.isInteger(submission.controlPolicy.maximumAttempts) || submission.controlPolicy.maximumAttempts < 1) {
    throw new Error("maximumAttempts must be a positive integer.");
  }
  if (!Number.isInteger(submission.controlPolicy.leaseDurationMilliseconds) || submission.controlPolicy.leaseDurationMilliseconds < 1) {
    throw new Error("leaseDurationMilliseconds must be a positive integer.");
  }
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(object[key] as JsonValue)}`,
  ).join(",")}}`;
}

function parseJson<T>(json: string): T {
  return JSON.parse(json) as T;
}

function parseJsonObject(json: string): JsonObject {
  return parseJson<JsonObject>(json);
}

function optionalJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function statusView(row: JobRow): JobStatusView {
  return {
    jobId: row.id as JobId,
    status: row.status,
    ...(row.progress_json === null
      ? {}
      : { progress: parseJson<JobProgress>(row.progress_json) }),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function recordFromRow(row: JobRow): PersistentJobRecord {
  return {
    id: row.id as JobId,
    revision: row.revision,
    kind: row.kind,
    status: row.status,
    payload: parseJsonObject(row.payload_json),
    priority: row.priority,
    idempotencyKey: row.idempotency_key,
    requestedBy: row.requested_by,
    controlPolicy: parseJson<PersistentJobRecord["controlPolicy"]>(row.control_policy_json),
    ...(row.progress_json === null ? {} : { progress: parseJson<JobProgress>(row.progress_json) }),
    ...(row.checkpoint_json === null ? {} : { checkpoint: parseJsonObject(row.checkpoint_json) }),
    ...(row.result_json === null ? {} : { result: parseJson<StructuredJobResult>(row.result_json) }),
    ...(row.error_json === null ? {} : { error: parseJson<StructuredJobError>(row.error_json) }),
    attempts: parseJson<PersistentJobRecord["attempts"]>(row.attempts_json),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function historyFromRow(row: HistoryRow): JobHistoryEvent {
  return {
    id: row.id as JobEventId,
    jobId: row.job_id as JobId,
    sequence: row.sequence,
    kind: row.kind,
    ...(row.from_status === null ? {} : { fromStatus: row.from_status }),
    toStatus: row.to_status,
    ...(row.worker_id === null ? {} : { workerId: row.worker_id as WorkerId }),
    details: parseJsonObject(row.details_json),
    occurredAt: row.occurred_at,
  };
}

function finishAttempt(
  row: JobRow,
  lease: JobLease,
  outcome: NonNullable<PersistentJobRecord["attempts"][number]["outcome"]>,
  error: StructuredJobError | undefined,
  finishedAt: string,
): PersistentJobRecord["attempts"] {
  const attempts = [...parseJson<PersistentJobRecord["attempts"]>(row.attempts_json)];
  const index = attempts.findIndex((attempt) => attempt.attempt === lease.attempt);
  const current = attempts[index];
  if (index < 0 || current === undefined || current.finishedAt !== undefined) {
    throw new StaleJobLeaseError(lease.jobId);
  }
  attempts[index] = {
    ...current,
    finishedAt,
    outcome,
    ...(error === undefined ? {} : { error }),
  };
  return attempts;
}

function retryConsumingAttempts(attempts: PersistentJobRecord["attempts"]): number {
  return attempts.filter((attempt) =>
    attempt.outcome === "failed" || attempt.outcome === "lease-expired",
  ).length;
}

export type JobQueueClient = Pick<
  JobClient,
  "submit" | "status" | "result" | "history" | "requestPause" | "resume" | "cancel"
>;
