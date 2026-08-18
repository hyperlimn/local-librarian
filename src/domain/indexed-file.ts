import type { ContentIdentityState } from "./content-identity.js";
import type {
  IndexedFileId,
  LibraryRootId,
  RootRelativePath,
} from "./ids.js";
import type { JsonObject } from "./json.js";
import type { FileProvenance } from "./provenance.js";

export type FileKind =
  | "document"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "software"
  | "other";

export interface FileSystemFacts {
  readonly byteLength: number;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly isSymbolicLink: boolean;
  readonly deviceId?: string;
  readonly fileSystemId?: string;
}

export interface PreservationSignals {
  readonly containingFolderDepth: number;
  readonly siblingCount?: number;
  readonly matchesKnownCollectionPattern: boolean;
  readonly userDefinedLabels: readonly string[];
}

export interface IndexedFile {
  readonly id: IndexedFileId;
  readonly libraryRootId: LibraryRootId;
  /** Locations are persisted relative to their approved root. */
  readonly relativePath: RootRelativePath;
  readonly name: string;
  readonly extension?: string;
  readonly kind: FileKind;
  readonly facts: FileSystemFacts;
  readonly identity: ContentIdentityState;
  readonly preservation: PreservationSignals;
  /** Append-only provenance retained independently of the current location. */
  readonly provenance: readonly FileProvenance[];
  readonly analyzerMetadata: JsonObject;
  readonly observedAt: string;
}
