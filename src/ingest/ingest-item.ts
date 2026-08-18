import type { FileClassification, MediaAnalysis } from "../analysis/index.js";
import type {
  ContentIdentity,
  FileSystemFacts,
  IndexedFileId,
  IngestFileProvenance,
  IngestItemId,
  IngestSessionId,
  JsonObject,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";

export interface IngestInventoryItem {
  readonly id: IngestItemId;
  readonly sessionId: IngestSessionId;
  readonly relativePath: RootRelativePath;
  readonly provenance: IngestFileProvenance;
  readonly facts: FileSystemFacts;
  readonly discoveredAt: string;
}

export interface ExactDuplicateMatch {
  readonly indexedFileId: IndexedFileId;
  readonly libraryRootId: LibraryRootId;
  readonly relativePath: RootRelativePath;
  readonly identity: ContentIdentity;
}

export type ExactDuplicateDecision =
  | { readonly status: "unique" }
  | {
      readonly status: "exact-duplicate";
      readonly matches: readonly ExactDuplicateMatch[];
    };

export type IngestClassificationDecision =
  | {
      readonly status: "classified";
      readonly classification: FileClassification;
      readonly destinationCandidates: readonly LibraryRootId[];
    }
  | {
      readonly status: "review-required";
      readonly reason:
        | "low-confidence"
        | "conflicting-classifiers"
        | "no-destination-route"
        | "ambiguous-destination"
        | "policy-requires-review";
      readonly candidates: readonly FileClassification[];
      readonly destinationCandidates: readonly LibraryRootId[];
    };

interface IdentifiedIngestItem extends IngestInventoryItem {
  readonly identity: ContentIdentity;
}

export interface DuplicateIngestItem extends IdentifiedIngestItem {
  readonly duplicateDecision: Extract<
    ExactDuplicateDecision,
    { readonly status: "exact-duplicate" }
  >;
}

export interface UniqueAnalyzedIngestItem extends IdentifiedIngestItem {
  readonly duplicateDecision: Extract<
    ExactDuplicateDecision,
    { readonly status: "unique" }
  >;
  readonly mediaAnalysis: readonly MediaAnalysis[];
  readonly analyzerMetadata: JsonObject;
  readonly classification: IngestClassificationDecision;
}

/**
 * Planning input after hashing and exact-duplicate lookup. Duplicate items may
 * bypass expensive metadata/classification work; unique items cannot reach the
 * planner without completing it.
 */
export type AnalyzedIngestItem =
  | DuplicateIngestItem
  | UniqueAnalyzedIngestItem;
