-- Shared catalog architecture. The jobs/job_history subset now has a runtime
-- adapter; the remaining tables are not opened by application code yet.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS library_roots (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  display_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL,
  approval_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_identities (
  id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL,
  digest_hex TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  verified_at TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  UNIQUE (algorithm, digest_hex, byte_length)
);

CREATE TABLE IF NOT EXISTS indexed_files (
  id TEXT PRIMARY KEY,
  library_root_id TEXT NOT NULL REFERENCES library_roots(id),
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  extension TEXT,
  kind TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  content_id TEXT REFERENCES content_identities(id),
  identity_state_json TEXT NOT NULL,
  preservation_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  analyzer_metadata_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (library_root_id, relative_path)
);

CREATE INDEX IF NOT EXISTS indexed_files_content_id
  ON indexed_files(content_id);

CREATE TABLE IF NOT EXISTS operation_plans (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  display_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL,
  approval_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  volume_identity TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_sessions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  source_id TEXT NOT NULL REFERENCES ingest_sources(id),
  status TEXT NOT NULL,
  analysis_job_id TEXT,
  transfer_job_id TEXT,
  plan_id TEXT,
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ingest_sessions(id),
  provenance_json TEXT NOT NULL,
  identity_id TEXT REFERENCES content_identities(id),
  analysis_json TEXT,
  disposition TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ingest_sessions(id),
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  kind TEXT NOT NULL,
  recovery_mode TEXT NOT NULL CHECK (
    recovery_mode IN ('restart', 'resume-from-checkpoint')
  ),
  status TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS inventory_scan_sessions (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  root_identity_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'paused', 'completed', 'failed', 'cancelled')
  ),
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
  observation_status TEXT NOT NULL CHECK (
    observation_status IN ('observed', 'skipped', 'error')
  ),
  byte_length INTEGER,
  created_at TEXT,
  modified_at TEXT,
  device_id TEXT,
  filesystem_record_id TEXT,
  hidden INTEGER CHECK (hidden IS NULL OR hidden IN (0, 1)),
  system INTEGER CHECK (system IS NULL OR system IN (0, 1)),
  read_only INTEGER CHECK (read_only IS NULL OR read_only IN (0, 1)),
  content_identity_status TEXT NOT NULL CHECK (
    content_identity_status = 'not-requested'
  ),
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
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'processing', 'completed')
  ),
  updated_at TEXT NOT NULL,
  UNIQUE (scan_id, relative_path)
);

CREATE INDEX IF NOT EXISTS inventory_frontier_next
  ON inventory_scan_frontier(scan_id, state, ordinal);

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

CREATE TABLE IF NOT EXISTS ingest_receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES ingest_sessions(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_entries (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  previous_entry_hash TEXT,
  entry_hash TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL
);

-- Defense in depth: journal rows cannot be edited or removed through SQLite.
CREATE TRIGGER IF NOT EXISTS journal_entries_reject_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal entries are append-only');
END;

CREATE TRIGGER IF NOT EXISTS journal_entries_reject_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal entries are append-only');
END;

CREATE TRIGGER IF NOT EXISTS job_history_reject_update
BEFORE UPDATE ON job_history
BEGIN
  SELECT RAISE(ABORT, 'job history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS job_history_reject_delete
BEFORE DELETE ON job_history
BEGIN
  SELECT RAISE(ABORT, 'job history is append-only');
END;
