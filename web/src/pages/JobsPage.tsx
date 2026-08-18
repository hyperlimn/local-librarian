import { useCallback, useEffect, useState } from "react";

import { api, post } from "../api";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { JobCard } from "../components/JobCard";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate } from "../format";
import type { Job } from "../types";

interface HistoryEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly occurredAt: string;
  readonly detail?: Record<string, unknown>;
}

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Job>();
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const page = await api<{ items: Job[] }>(`/api/jobs${query}`);
      setJobs(page.items);
      setError(undefined);
    } catch (value) { setError(value instanceof Error ? value.message : "Jobs could not be loaded."); }
  }, [status]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function control(job: Job, action: "pause" | "resume" | "cancel") {
    try { await post(`/api/jobs/${encodeURIComponent(job.id)}/${action}`); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : `Could not ${action} job.`); }
  }

  async function details(job: Job) {
    try {
      const [freshJob, events] = await Promise.all([
        api<Job>(`/api/jobs/${encodeURIComponent(job.id)}`),
        api<{ events: HistoryEvent[] }>(`/api/jobs/${encodeURIComponent(job.id)}/history`),
      ]);
      setSelected(freshJob); setHistory(events.events);
      if (freshJob.status === "completed") setResult(await api<unknown>(`/api/jobs/${encodeURIComponent(job.id)}/result`));
      else setResult(undefined);
    } catch (value) { setError(value instanceof Error ? value.message : "Job detail could not be loaded."); }
  }

  return (
    <div className="page-stack">
      <header className="page-header page-header--split"><div><span className="eyebrow">Persistent local work</span><h1>Jobs</h1><p>Submitted work outlives the browser and is processed by the independent local worker.</p></div><label className="select-control"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All jobs</option><option value="queued">Queued</option><option value="running">Running</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label></header>
      {error && <div className="notice notice--error">{error}</div>}
      <section className="card-grid card-grid--jobs">
        {jobs.map((job) => <JobCard key={job.id} job={job} onPause={() => void control(job, "pause")} onResume={() => void control(job, "resume")} onCancel={() => void control(job, "cancel")} onDetails={() => void details(job)} />)}
        {jobs.length === 0 && <div className="quiet-card">No jobs match this status.</div>}
      </section>
      <ConfirmationDialog open={selected !== undefined} title="Job history and result" confirmLabel="Close" hideCancel onCancel={() => setSelected(undefined)} onConfirm={() => setSelected(undefined)}>
        {selected && <div className="job-detail"><div className="job-detail__heading"><div><span className="eyebrow">{selected.kind}</span><code>{selected.id}</code></div><StatusBadge status={selected.status} /></div><dl className="detail-grid"><div><dt>Submitted</dt><dd>{formatDate(selected.submittedAt)}</dd></div><div><dt>Updated</dt><dd>{formatDate(selected.updatedAt)}</dd></div><div><dt>Attempts</dt><dd>{selected.attempts.length}</dd></div><div><dt>Status</dt><dd>{selected.status}</dd></div></dl><h3>History</h3><ol className="history-list">{history.map((event) => <li key={event.sequence}><span>{event.kind}</span><time>{formatDate(event.occurredAt)}</time></li>)}</ol>{result !== undefined && <><h3>Structured result</h3><pre className="structured-result">{JSON.stringify(result, null, 2)}</pre></>}</div>}
      </ConfirmationDialog>
    </div>
  );
}
