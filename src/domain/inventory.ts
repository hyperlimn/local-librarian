import type { ContentIdentityState } from "./content-identity.js";
import type {
  InventoryRecordId,
  InventoryScanId,
  JobId,
  LibraryRootId,
  RootRelativePath,
} from "./ids.js";
import type { JsonObject } from "./json.js";

export type InventoryEntryType =
  | "file"
  | "directory"
  | "symbolic-link"
  | "other"
  | "unknown";

export type InventoryObservationStatus = "observed" | "skipped" | "error";

export interface InventoryEntryAttributes {
  readonly hidden?: boolean;
  readonly system?: boolean;
  readonly readOnly?: boolean;
}

/** An immutable point-in-time metadata observation; no content was opened. */
export interface InventoryRecord {
  readonly id: InventoryRecordId;
  readonly scanId: InventoryScanId;
  readonly rootId: LibraryRootId;
  readonly jobId: JobId;
  readonly relativePath: RootRelativePath;
  readonly name: string;
  readonly extension?: string;
  readonly entryType: InventoryEntryType;
  readonly observationStatus: InventoryObservationStatus;
  readonly byteLength?: number;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly deviceId?: string;
  readonly filesystemRecordId?: string;
  readonly attributes: InventoryEntryAttributes;
  readonly contentIdentity: ContentIdentityState & { readonly status: "not-requested" };
  readonly issue?: {
    readonly code: string;
    readonly message: string;
  };
  readonly observedAt: string;
}

export interface InventoryScanCounts extends JsonObject {
  readonly recordsObserved: number;
  readonly filesDiscovered: number;
  readonly directoriesVisited: number;
  readonly bytesRepresented: number;
  readonly skippedEntries: number;
  readonly errorEntries: number;
}

export type InventoryScanStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface InventoryScanCheckpoint extends JsonObject {
  readonly scanId: string;
  readonly currentRelativePath: string;
  readonly recordsObserved: number;
  readonly filesDiscovered: number;
  readonly directoriesVisited: number;
  readonly bytesRepresented: number;
  readonly skippedEntries: number;
  readonly errorEntries: number;
}

export interface InventoryScanSession {
  readonly id: InventoryScanId;
  readonly rootId: LibraryRootId;
  readonly jobId: JobId;
  readonly rootIdentityKey: string;
  readonly status: InventoryScanStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
  readonly counts: InventoryScanCounts;
  readonly checkpoint?: InventoryScanCheckpoint;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface InventorySummary {
  readonly rootId: LibraryRootId;
  readonly latestScan?: InventoryScanSession;
  readonly retainedScanCount: number;
}

export interface InventoryPage {
  readonly scanId?: InventoryScanId;
  readonly items: readonly InventoryRecord[];
  readonly nextCursor?: string;
}

export interface InventoryScanPage {
  readonly items: readonly InventoryScanSession[];
  readonly nextCursor?: string;
}
