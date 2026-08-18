import { useCallback, useEffect, useState } from "react";

import { api, post } from "../api";
import { JobCard } from "../components/JobCard";
import { LibraryCard } from "../components/LibraryCard";
import { SafetyIndicator } from "../components/SafetyIndicator";
import { ScanProgress } from "../components/ScanProgress";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate, shortId } from "../format";
import type { Job, LibraryView, Scan, WorkerStatus } from "../types";

interface DashboardData {
  libraries: LibraryView[];
  activeJobs: Job[];
  recentJobs: Job[];
  recentScans: Scan[];
  worker: WorkerStatus;
  attention: Array<{ kind: string; id: string; message: string }>;
  system: { fileMutation: string; safetyStatus: string };
}

export function DashboardPage({ navigate }: { readonly navigate: (page: string) => void }) {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setData(await api<DashboardData>("/api/dashboard"));
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Dashboard unavailable.");
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function startWorker() {
    await post("/api/worker/start");
    await load();
  }

  if (!data) return <PageState title="Preparing your library" message={error ?? "Loading Local Librarian…"} />;
  const latestRunning = data.recentScans.find((scan) => scan.status === "running" || scan.status === "paused");
  const latestJob = latestRunning === undefined
    ? undefined
    : data.activeJobs.find((job) => job.id === latestRunning.jobId);
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <span className="eyebrow">Local overview</span>
          <h1>Your libraries, quietly organized.</h1>
          <p>Read-only metadata inventory with durable background work and explicit root approval.</p>
        </div>
        <SafetyIndicator compact />
      </section>

      {error && <div className="notice notice--error">{error}</div>}
      <section className="stat-strip">
        <Stat value={data.libraries.filter((item) => item.root.approval.status === "approved").length} label="Approved libraries" />
        <Stat value={data.activeJobs.length} label="Active jobs" />
        <Stat value={data.recentScans.length} label="Recent scans" />
        <div className="stat-card stat-card--worker">
          <span>Worker</span><StatusBadge status={data.worker.status} />
          {(data.worker.status === "offline" || data.worker.status === "stale") && <button className="button button--mini" onClick={() => void startWorker()}>Start worker</button>}
        </div>
      </section>

      {latestRunning && <ScanProgress scan={latestRunning} progress={latestJob?.progress} />}

      <SectionHeader title="Libraries" action="Manage libraries" onAction={() => navigate("libraries")} />
      <section className="card-grid card-grid--libraries">
        {data.libraries.slice(0, 3).map((library) => (
          <LibraryCard key={library.root.id} library={library} onBrowse={() => navigate("inventory")} />
        ))}
        {data.libraries.length === 0 && <EmptyCard title="No libraries enrolled" copy="Choose a mounted drive or folder, review it, and explicitly approve it." action="Enroll a library" onAction={() => navigate("libraries")} />}
      </section>

      <div className="two-column">
        <section>
          <SectionHeader title="Active work" action="All jobs" onAction={() => navigate("jobs")} />
          <div className="stack-list">
            {data.activeJobs.slice(0, 3).map((job) => <JobCard key={job.id} job={job} />)}
            {data.activeJobs.length === 0 && <div className="quiet-card">No work is currently queued or running.</div>}
          </div>
        </section>
        <section>
          <SectionHeader title="Needs attention" />
          <div className="attention-list">
            {data.attention.slice(0, 5).map((item) => <div className="attention-item" key={`${item.kind}-${item.id}`}><span>!</span><div><strong>{item.kind}</strong><p>{item.message}</p></div></div>)}
            {data.attention.length === 0 && <div className="quiet-card quiet-card--success">Everything looks calm. No failed jobs or scans.</div>}
          </div>
        </section>
      </div>

      <SectionHeader title="Recent jobs" action="Full job history" onAction={() => navigate("jobs")} />
      <section className="card-grid card-grid--jobs">
        {data.recentJobs.filter((job) => !data.activeJobs.some((active) => active.id === job.id)).slice(0, 3).map((job) => <JobCard key={job.id} job={job} />)}
        {data.recentJobs.length === 0 && <div className="quiet-card">No job history yet.</div>}
      </section>

      <SectionHeader title="Recent scans" action="All scan sessions" onAction={() => navigate("scans")} />
      <section className="compact-scan-list">
        {data.recentScans.slice(0, 4).map((scan) => <article className="compact-scan" key={scan.id}><div><strong>{shortId(scan.id)}</strong><small>{formatDate(scan.completedAt ?? scan.startedAt)}</small></div><div><span>{scan.counts.filesDiscovered.toLocaleString()} files</span><span>{formatBytes(scan.counts.bytesRepresented)}</span></div><StatusBadge status={scan.status} /></article>)}
        {data.recentScans.length === 0 && <div className="quiet-card">No scan sessions yet.</div>}
      </section>
    </div>
  );
}

function Stat({ value, label }: { readonly value: number; readonly label: string }) {
  return <div className="stat-card"><strong>{value.toLocaleString()}</strong><span>{label}</span></div>;
}

function SectionHeader({ title, action, onAction }: { readonly title: string; readonly action?: string; readonly onAction?: () => void }) {
  return <div className="section-heading"><h2>{title}</h2>{action && <button className="button button--text" onClick={onAction}>{action} →</button>}</div>;
}

function EmptyCard({ title, copy, action, onAction }: { readonly title: string; readonly copy: string; readonly action: string; readonly onAction: () => void }) {
  return <div className="empty-card"><span>＋</span><h3>{title}</h3><p>{copy}</p><button className="button button--primary" onClick={onAction}>{action}</button></div>;
}

function PageState({ title, message }: { readonly title: string; readonly message: string }) {
  return <div className="page-state"><div className="spinner" /><h1>{title}</h1><p>{message}</p></div>;
}
