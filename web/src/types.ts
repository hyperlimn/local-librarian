export type Status =
  | "approved" | "revoked" | "queued" | "running" | "paused"
  | "completed" | "failed" | "cancelled" | "offline" | "starting"
  | "stale" | "observed" | "skipped" | "error";

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

