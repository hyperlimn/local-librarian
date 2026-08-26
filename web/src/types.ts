export type Status =
  | "approved" | "revoked" | "queued" | "running" | "paused"
  | "completed" | "failed" | "cancelled" | "offline" | "starting"
  | "stale" | "observed" | "skipped" | "error" | "partial" | "ready" | "archived"
  | "not-started" | "analyzing" | "needs-review" | "ready-for-approval"
  | "approved" | "transferring" | "transfer-queued" | "analysis-queued"
  | "active" | "restoring" | "restored" | "restore-blocked" | "verified";

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
  kind?: "folder" | "drive" | "sd-card" | "drop-directory";
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
  policy: {
    allowWrites: boolean;
    stayOnFileSystem: boolean;
    allowSourceRetirement?: boolean;
    removableMedia?: boolean;
  };
}

export interface LibraryView {
  root: Root;
  summary: { rootId: string; retainedScanCount: number; latestScan?: Scan };
}

export interface Progress {
  phase: string;
  completedUnits: number;
  totalUnits?: number;
  percent?: number;
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
    contentIdentity: boolean;
    duplicates: boolean;
    metadataAnalysis: boolean;
    relationships: boolean;
    needsReview: boolean;
    scalableReconciliation: boolean;
    ingest: boolean;
    quarantine: boolean;
    crossVolumeOrganization: boolean;
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
    philosophy: "conservative" | "balanced" | "deep";
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
    preservedCoherentGroups: number;
    needsReviewExcluded: number;
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


export interface PersistedReconciliation {
  id: string;
  rootId: string;
  baselineScanId: string;
  comparisonScanId: string;
  jobId?: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  phase: "missing" | "added" | "changed" | "complete";
  processed: number;
  counts: {
    added: number;
    missing: number;
    metadataChanged: number;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
}

export interface PersistedReconciliationDelta {
  id: number;
  reconciliationId: string;
  relativePath: string;
  kind: "added" | "missing" | "metadata-changed";
  changedFields: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}
export interface IntelligenceSummary {
  filesAnalyzed: number;
  filesAwaitingAnalysis: number;
  candidateDuplicateGroups: number;
  exactDuplicateGroups: number;
  reclaimableDuplicateBytes: number;
  needsReview: number;
  quarantineCount: number;
}

export interface AnalysisStage {
  rootId: string;
  scanId: string;
  stage: "candidate-duplicates" | "content-identity" | "metadata" | "relationships" | "classification";
  status: Status;
  jobId?: string;
  processed: number;
  total?: number;
  details: Record<string, unknown>;
  error?: { code: string; message: string };
  updatedAt: string;
  completedAt?: string;
}

export interface AnalysisStatus {
  rootId: string;
  scanId?: string;
  stages: AnalysisStage[];
  totals: {
    files: number;
    analyzed: number;
    hashesVerified: number;
    hashesReused: number;
    candidateDuplicateGroups: number;
    exactDuplicateGroups: number;
    needsReview: number;
    semanticGroups: number;
  };
}

export interface DuplicateGroup {
  id: string;
  rootId: string;
  scanId: string;
  kind: "candidate" | "exact";
  groupKey: string;
  copyCount: number;
  byteLength: number;
  totalBytes: number;
  reclaimableBytes: number;
  verificationState: "candidate" | "partially-verified" | "verified";
  keeperCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateMember {
  groupId: string;
  recordId: string;
  rootId: string;
  scanId: string;
  relativePath: string;
  name: string;
  byteLength: number;
  createdAt?: string;
  modifiedAt?: string;
  hashState: "not-hashed" | "verified" | "reused";
  decision: "undecided" | "keep" | "consolidate" | "keep-all";
}

export interface NeedsReviewItem {
  id: string;
  rootId: string;
  scanId: string;
  recordId?: string;
  groupId?: string;
  reason: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  status: "open" | "resolved" | "dismissed";
  resolution?: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
}

export interface EnrichedInventoryItem {
  recordId: string;
  rootId: string;
  scanId: string;
  relativePath: string;
  name: string;
  extension?: string;
  byteLength?: number;
  createdAt?: string;
  modifiedAt?: string;
  mimeType?: string;
  category?: string;
  captureAt?: string;
  durationSeconds?: number;
  hashState: "not-requested" | "verified" | "reused";
  duplicateState: "none" | "candidate" | "exact";
  analysisState: "not-analyzed" | "analyzed" | "partial" | "failed";
  needsReview: boolean;
  semanticGroups: Array<{ id: string; kind: string; displayName: string }>;
}

export interface TransferPlan {
  id: string;
  kind: "ingest" | "cross-volume-organization" | "duplicate-consolidation";
  sourceRootId: string;
  sourceRootIdentityKey: string;
  sourceDisplayPath: string;
  destinationRootId?: string;
  targetDirectory?: string;
  retireSource: boolean;
  preserveSourceFolders: boolean;
  status: Status;
  analysisJobId?: string;
  transferJobId?: string;
  counts: {
    total: number;
    ready: number;
    exactDuplicates: number;
    needsReview: number;
    completed: number;
    quarantined: number;
    failed: number;
    totalBytes: number;
    copiedBytes: number;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  error?: { code: string; message: string };
}

export interface TransferItem {
  id: string;
  planId: string;
  ordinal: number;
  sourceRelativePath: string;
  originalSourcePath: string;
  originalFileName: string;
  destinationRelativePath?: string;
  byteLength: number;
  algorithm?: "sha256";
  digestHex?: string;
  category?: string;
  mimeType?: string;
  confidence?: number;
  explanation?: string;
  metadata: Record<string, unknown>;
  duplicateMatches: Array<{ recordId: string; rootId: string; relativePath: string }>;
  status: Status;
  copiedBytes: number;
  destinationVerifiedAt?: string;
  quarantineItemId?: string;
  error?: { code: string; message: string; retryable: boolean };
  updatedAt: string;
}

export interface QuarantineItem {
  id: string;
  rootId: string;
  originalRelativePath: string;
  quarantinedRelativePath: string;
  originalFileName: string;
  algorithm: "sha256";
  digestHex: string;
  byteLength: number;
  reason: "duplicate-consolidation" | "verified-source-retirement";
  planId: string;
  transferItemId: string;
  jobId: string;
  status: "active" | "restoring" | "restored" | "restore-blocked";
  quarantinedAt: string;
  restoredAt?: string;
  restoreJobId?: string;
  error?: { code: string; message: string };
}

export interface ResourceSettings {
  maximumHashingWorkers: number;
  metadataConcurrency: number;
  transferConcurrency: number;
  throughputMode: "disk-friendly" | "balanced" | "maximum";
  pauseHeavyWork: boolean;
  analysisDepth: "essentials" | "standard" | "deep";
  localModel: {
    enabled: boolean;
    adapter: "ollama" | "custom";
    endpoint: string;
    model: string;
    allowTextSamples: boolean;
  };
}
