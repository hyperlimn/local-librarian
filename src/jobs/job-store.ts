import type { JobId } from "../domain/index.js";
import type {
  JobHistoryEvent,
  JobStatus,
  PersistentJobRecord,
} from "./job.js";

export interface JobListQuery {
  readonly statuses?: readonly JobStatus[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface JobRecordPage {
  readonly items: readonly PersistentJobRecord[];
  readonly nextCursor?: string;
}

/**
 * Durable compare-and-swap storage. Record changes and appended history events
 * must commit atomically so crash recovery can reason from persistent state.
 */
export interface PersistentJobStore {
  create(
    record: PersistentJobRecord,
    initialEvent: JobHistoryEvent,
  ): Promise<void>;
  get(jobId: JobId): Promise<PersistentJobRecord | undefined>;
  getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PersistentJobRecord | undefined>;
  update(
    expectedRevision: number,
    record: PersistentJobRecord,
    event: JobHistoryEvent,
  ): Promise<boolean>;
  streamHistory(jobId: JobId): AsyncIterable<JobHistoryEvent>;
  list(query?: JobListQuery): Promise<JobRecordPage>;
}

export const PERSISTENT_JOB_STORE_IMPLEMENTATION_STATUS =
  "sqlite-implemented" as const;
