import type { JobStatus } from "./job.js";

const ALLOWED_TRANSITIONS = {
  queued: ["running", "paused", "cancelled"],
  running: ["queued", "paused", "completed", "failed", "cancelled"],
  paused: ["queued", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
} as const satisfies Readonly<Record<JobStatus, readonly JobStatus[]>>;

export function canTransitionJob(
  from: JobStatus,
  to: JobStatus,
): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly JobStatus[]).includes(to);
}

export class InvalidJobTransitionError extends Error {
  public constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid job status transition: ${from} -> ${to}`);
    this.name = "InvalidJobTransitionError";
  }
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new InvalidJobTransitionError(from, to);
  }
}

