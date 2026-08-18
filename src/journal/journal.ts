import type { JournalEntry } from "../domain/index.js";

export interface JournalReadOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface JournalIntegrityReport {
  readonly valid: boolean;
  readonly entriesChecked: number;
  readonly firstInvalidSequence?: number;
  readonly reason?: string;
}

/**
 * Append-only journal port. Implementations must use create-only/append
 * semantics and reject edits, truncation, or out-of-order sequence numbers.
 */
export interface JournalStore {
  append(entry: JournalEntry): Promise<void>;
  read(options?: JournalReadOptions): AsyncIterable<JournalEntry>;
  verifyIntegrity(): Promise<JournalIntegrityReport>;
}

export interface JournalEntryHasher {
  hash(entry: Omit<JournalEntry, "entryHash">): Promise<string>;
}

export interface JsonlJournalOptions {
  /** Must be within an approved root's control directory. */
  readonly journalPath: string;
  readonly flushAfterEveryEntry: true;
}

export const JSONL_JOURNAL_IMPLEMENTATION_STATUS = "scaffold-only" as const;

