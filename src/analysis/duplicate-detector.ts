import type {
  ContentIdentity,
  IndexedFile,
  IndexedFileId,
} from "../domain/index.js";

export interface DuplicateGroup {
  readonly identity: ContentIdentity;
  readonly fileIds: readonly IndexedFileId[];
}

/** Finds candidates only; quarantine decisions belong to the planner. */
export interface DuplicateDetector {
  findExactDuplicates(
    files: AsyncIterable<IndexedFile>,
  ): AsyncIterable<DuplicateGroup>;
}

