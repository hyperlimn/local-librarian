import type {
  IngestSessionId,
  IngestSourceId,
  RootRelativePath,
} from "./ids.js";

/** Immutable evidence of where an ingested file was originally discovered. */
export interface IngestFileProvenance {
  readonly kind: "ingest-source";
  readonly ingestSessionId: IngestSessionId;
  readonly ingestSourceId: IngestSourceId;
  readonly sourceDisplayName: string;
  /** Full source path exactly as recorded during discovery. */
  readonly originalSourcePath: string;
  readonly originalRelativePath: RootRelativePath;
  readonly originalFileName: string;
  readonly sourceVolumeIdentity?: string;
  readonly discoveredAt: string;
}

export type FileProvenance = IngestFileProvenance;

