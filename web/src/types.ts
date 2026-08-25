export type Status =
  | "approved" | "revoked" | "queued" | "running" | "paused"
  | "completed" | "failed" | "cancelled" | "offline" | "starting"
  | "stale" | "observed" | "skipped" | "error" | "partial" | "ready" | "archived";

export interface Counts {
  recordsObserved: number;
  filesDiscovered: number;
  directoriesVisited: number;
  bytesRepresented: number;
  skippedEntries: number;
  errorEntries: number;
}

export interface Scan {
  id: string;
  rootId: string;
  jobId: string;
  status: Status;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  counts: Counts;
  checkpoint?: { currentRelativePath: string } & Counts;
  error?: { code: string; message: string };
}

export interface Root {
  id: string;
  displayName: string;
  displayPath: string;
  canonicalPath: string;
  approval: { status: "approved"; approvedAt: string; approvedBy: string } |
    { status: "revoked"; revokedAt: string; reason: string };
  identity: {
    key: string;
    volume: {
      key: string;
      stability: string;
      deviceId: string;
      fileSystemTypeName?: string;
      volumeGuid?: string;
    };
  };
  policy: { allowWrites: boolean; stayOnFileSystem: boolean };
}

export interface LibraryView {
  root: Root;
  summary: { rootId: string; retainedScanCount: number; latestScan?: Scan };
}

export interface Progress {
  phase: string;
  completedUnits: number;
  unit: string;
  message?: string;
  updatedAt: string;
  metrics?: {
    filesDiscovered?: number;
    directoriesVisited?: number;
    bytesRepresented?: number;
    skippedEntries?: number;
    errorEntries?: number;
    currentRelativeLocation?: string;
  };
}

export interface Job {
  id: string;
  kind: string;
  status: Status;
  progress?: Progress;
  attempts: Array<{
    attempt: number;
    workerId?: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: string;
  }>;
  error?: { code: string; message: string; retryable: boolean };
  result?: { summary: Record<string, unknown>; completedAt: string };
  submittedAt: string;
  updatedAt: string;
}

export interface InventoryRecord {
  id: string;
  scanId: string;
  rootId: string;
  jobId: string;
  relativePath: string;
  name: string;
  extension?: string;
  entryType: string;
  observationStatus: Status;
  byteLength?: number;
  createdAt?: string;
  modifiedAt?: string;
  issue?: { code: string; message: string };
  observedAt: string;
}

export interface WorkerStatus {
  status: "offline" | "starting" | "running" | "stale";
  workerId?: string;
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
}

export interface DiscoveredVolume {
  mountPath: string;
  driveLetter?: string;
  label?: string;
  filesystem?: string;
  totalBytes?: number;
  freeBytes?: number;
  classification: string;
  enrollmentStatus: "not-enrolled" | "enrolled";
  rootId?: string;
  approvalStatus?: string;
}

export interface Proposal {
  proposalId: string;
  displayName: string;
  displayPath: string;
  canonicalPath: string;
  identity: Root["identity"];
  warnings: string[];
  approvalRequired: true;
  proposedAt: string;
}
export interface SystemState {
  version: string;
  binding: "loopback-only";
  safetyStatus: "enforced";
  filesystemExecution: "simulation-only" | "live";
  fileMutation: "DISABLED" | "ENABLED";
  mutationMode: {
    mode: "read-only" | "live";
    updatedAt: string;
    updatedBy: string;
  };
  capabilities: {
    inventory: true;
    planning: true;
    simulation: true;
    liveRelocation: boolean;
    rollback: true;
  };
  databasePaths: Record<string, string>;
}

export interface OrganizationPlan {
  id: string;
  rootId: string;
  rootIdentityKey: string;
  scanId: string;
  status: "ready" | "archived";
  options: {
    strategy: "category" | "category-and-year" | "year-and-month";
    scope: "top-level" | "all-files";
    targetDirectory: string;
    collisionPolicy: "skip" | "rename-with-suffix";
    includeHidden: boolean;
    maximumOperations: number;
  };
  counts: {
    scannedFiles: number;
    eligibleFiles: number;
    plannedMoves: number;
    representedBytes: number;
    preservedByScope: number;
    alreadyOrganized: number;
    hiddenExcluded: number;
    conflictsSkipped: number;
    limitedOut: number;
    byCategory: Record<string, number>;
  };
  createdAt: string;
  createdBy: string;
}

export interface OrganizationOperation {
  id: string;
  planId: string;
  ordinal: number;
  sourceRelativePath: string;
  destinationRelativePath: string;
  category: string;
  rationale: string;
  expected: {
    byteLength: number;
    modifiedAt?: string;
    deviceId?: string;
    filesystemRecordId?: string;
  };
}

export interface OrganizationRun {
  id: string;
  planId: string;
  sourceRunId?: string;
  jobId?: string;
  mode: "simulation" | "live" | "rollback-simulation" | "rollback-live";
  status: Status;
  approvedBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: { code: string; message: string };
  counts: {
    total: number;
    processed: number;
    succeeded: number;
    skipped: number;
    failed: number;
  };
}

export interface OrganizationRunItem {
  runId: string;
  operationId: string;
  outcome: string;
  message: string;
  completedAt: string;
  operation: OrganizationOperation;
}

export interface OrganizationAuditEvent {
  sequence: number;
  id: string;
  event: string;
  occurredAt: string;
  actor: string;
  correlationId: string;
  previousHash?: string;
  entryHash: string;
  details: Record<string, unknown>;
}

export interface AuditIntegrity {
  valid: boolean;
  entriesChecked: number;
  firstInvalidSequence?: number;
  reason?: string;
}

export interface ReconciliationDelta {
  relativePath: string;
  kind: "added" | "missing" | "metadata-changed";
  changedFields?: string[];
}

export interface ReconciliationReport {
  rootId: string;
  baselineScanId: string;
  comparisonScanId: string;
  deltas: ReconciliationDelta[];
  generatedAt: string;
}

