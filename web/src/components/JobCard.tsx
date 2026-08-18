import { formatDate, shortId } from "../format";
import type { Job } from "../types";
import { StatusBadge } from "./StatusBadge";

export function JobCard({ job, onPause, onResume, onCancel, onDetails }: {
  readonly job: Job;
  readonly onPause?: () => void;
  readonly onResume?: () => void;
  readonly onCancel?: () => void;
  readonly onDetails?: () => void;
}) {
  return (
    <article className="job-card">
      <div className="job-card__head">
        <div>
          <span className="eyebrow">{job.kind}</span>
          <h3 title={job.id}>{shortId(job.id)}</h3>
        </div>
        <StatusBadge status={job.status} />
      </div>
      {job.progress && (
        <div className="job-progress-copy">
          <strong>{job.progress.completedUnits.toLocaleString()} {job.progress.unit}</strong>
          <span>{job.progress.message ?? job.progress.phase}</span>
        </div>
      )}
      <dl className="job-meta">
        <div><dt>Submitted</dt><dd>{formatDate(job.submittedAt)}</dd></div>
        <div><dt>Updated</dt><dd>{formatDate(job.updatedAt)}</dd></div>
        <div><dt>Attempts</dt><dd>{job.attempts.length}</dd></div>
      </dl>
      {job.error && <p className="inline-error">{job.error.code}: {job.error.message}</p>}
      <div className="card-actions">
        {job.status === "running" && onPause && <button className="button button--soft" onClick={onPause}>Pause</button>}
        {job.status === "paused" && onResume && <button className="button button--primary" onClick={onResume}>Resume</button>}
        {(job.status === "queued" || job.status === "running" || job.status === "paused") && onCancel && <button className="button button--text button--danger-text" onClick={onCancel}>Cancel</button>}
        {onDetails && <button className="button button--text" onClick={onDetails}>History & result</button>}
      </div>
    </article>
  );
}
