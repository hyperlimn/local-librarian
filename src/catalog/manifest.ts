import type {
  IndexedFile,
  JournalEntry,
  LibraryRoot,
  OperationPlan,
} from "../domain/index.js";
import type { IngestReceipt } from "../ingest/index.js";
import type { JobHistoryEvent, PersistentJobRecord } from "../jobs/index.js";

export type ManifestRecord =
  | {
      readonly recordType: "manifest-header";
      readonly formatVersion: 1;
      readonly generatedAt: string;
    }
  | { readonly recordType: "library-root"; readonly value: LibraryRoot }
  | { readonly recordType: "indexed-file"; readonly value: IndexedFile }
  | { readonly recordType: "operation-plan"; readonly value: OperationPlan }
  | { readonly recordType: "ingest-receipt"; readonly value: IngestReceipt }
  | { readonly recordType: "job-record"; readonly value: PersistentJobRecord }
  | { readonly recordType: "job-history"; readonly value: JobHistoryEvent }
  | { readonly recordType: "journal-entry"; readonly value: JournalEntry };

/** JSONL export/import port. It does not choose paths or open files itself. */
export interface ManifestStore {
  export(records: AsyncIterable<ManifestRecord>): Promise<void>;
  import(): AsyncIterable<ManifestRecord>;
}
