import { useCallback, useEffect, useState } from "react";

import { api, post } from "../api";
import { JobCard } from "../components/JobCard";
import { LibraryCard } from "../components/LibraryCard";
import { SafetyIndicator } from "../components/SafetyIndicator";
import { ScanProgress } from "../components/ScanProgress";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate, shortId } from "../format";
import type { IntelligenceSummary, Job, LibraryView, OrganizationPlan, OrganizationRun, Scan, SystemState, WorkerStatus } from "../types";

interface DashboardData {
  libraries: LibraryView[];
  activeJobs: Job[];
  recentJobs: Job[];
  recentScans: Scan[];
  recentPlans: OrganizationPlan[];
  recentRuns: OrganizationRun[];
  worker: WorkerStatus;
  intelligence: IntelligenceSummary;
  attention: Array<{ kind: string; id: string; message: string }>;
  system: SystemState;
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
  const approvedLibraries = data.libraries.filter((item) => item.root.approval.status === "approved");
  const latestSnapshots = approvedLibraries
    .map((item) => item.summary.latestScan)
    .filter((scan): scan is Scan => scan?.status === "completed");
  const indexedFiles = latestSnapshots.reduce((total, scan) => total + scan.counts.filesDiscovered, 0);
  const storageRepresented = latestSnapshots.reduce((total, scan) => total + scan.counts.bytesRepresented, 0);
  const firstRunIncomplete = approvedLibraries.length === 0 || latestSnapshots.length === 0 || data.intelligence.filesAnalyzed === 0;
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <span className="eyebrow">Local overview</span>
          <h1>Your libraries, quietly organized.</h1>
          <p>Inventory messy storage quickly, progressively understand its contents and relationships, review uncertainty, then execute approved changes through the safety-gated physical layer.</p>
        </div>
        <SafetyIndicator compact mode={data.system.mutationMode.mode} />
      </section>

      {error && <div className="notice notice--error">{error}</div>}
      {firstRunIncomplete && <FirstRunGuide libraries={approvedLibraries.length} scans={latestSnapshots.length} analyzed={data.intelligence.filesAnalyzed} plans={data.recentPlans.length} mode={data.system.mutationMode.mode} navigate={navigate} />}
      <section className="stat-strip stat-strip--intelligence">
        <Stat value={approvedLibraries.length} label="Libraries" onClick={() => navigate("libraries")} />
        <Stat value={indexedFiles} label="Indexed files" onClick={() => navigate("inventory")} />
        <Stat value={formatBytes(storageRepresented)} label="Storage represented" onClick={() => navigate("inventory")} />
        <Stat value={data.intelligence.filesAnalyzed} label="Files analyzed" onClick={() => navigate("analyze")} />
        <Stat value={data.intelligence.filesAwaitingAnalysis} label="Awaiting analysis" onClick={() => navigate("analyze")} />
        <Stat value={data.intelligence.exactDuplicateGroups} label="Exact duplicate groups" onClick={() => navigate("duplicates")} />
        <Stat value={formatBytes(data.intelligence.reclaimableDuplicateBytes)} label="Reclaimable duplicate space" onClick={() => navigate("duplicates")} />
        <Stat value={data.intelligence.needsReview} label="Needs Review" onClick={() => navigate("needs-review")} />
        <Stat value={data.intelligence.quarantineCount} label="Quarantined copies" onClick={() => navigate("quarantine")} />
        <Stat value={data.activeJobs.length} label="Active jobs" onClick={() => navigate("jobs")} />
        <div className="stat-card stat-card--worker">
          <span>Worker health</span><StatusBadge status={data.worker.status} />
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
      <SectionHeader title="Organization plans" action="Plan and organize" onAction={() => navigate("organize")} />
      <section className="compact-scan-list">
        {data.recentPlans.slice(0, 4).map((plan) => {
          const run = data.recentRuns.find((candidate) => candidate.planId === plan.id);
          return <article className="compact-scan" key={plan.id}><div><strong>{shortId(plan.id)}</strong><small>{plan.options.strategy.replaceAll("-", " ")} · {formatDate(plan.createdAt)}</small></div><div><span>{plan.counts.plannedMoves.toLocaleString()} moves</span><span>{formatBytes(plan.counts.representedBytes)}</span></div><StatusBadge status={run?.status ?? plan.status} /></article>;
        })}
        {data.recentPlans.length === 0 && <div className="quiet-card">Create a plan from a completed inventory to begin organizing.</div>}
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

function Stat({ value, label, onClick }: { readonly value: number | string; readonly label: string; readonly onClick: () => void }) {
  const display = typeof value === "number" ? value.toLocaleString() : value;
  return <button className="stat-card stat-card--link" onClick={onClick}><strong>{display}</strong><span>{label}</span><small>Open →</small></button>;
}

function FirstRunGuide({ libraries, scans, analyzed, plans, mode, navigate }: {
  readonly libraries: number;
  readonly scans: number;
  readonly analyzed: number;
  readonly plans: number;
  readonly mode: "read-only" | "live";
  readonly navigate: (page: string) => void;
}) {
  const steps = [
    { label: "Local and private", copy: "Catalogs, hashes, metadata, and optional model inference stay on this computer.", done: true },
    { label: "Safety mode", copy: mode === "read-only" ? "READ ONLY is active; planning and simulation cannot mutate files." : "FULL ORGANIZATION is active, with a separate write gate for every library.", done: true, page: "safety" },
    { label: "Select a library", copy: "Explicitly enroll the folder or mounted volume you want Local Librarian to know.", done: libraries > 0, page: "libraries" },
    { label: "Inventory it", copy: "Capture a fast metadata-only snapshot as a durable background job.", done: scans > 0, page: "inventory" },
    { label: "Analyze progressively", copy: "Find duplicate candidates, selectively hash, extract metadata, and detect relationships.", done: analyzed > 0, page: "analyze" },
    { label: "Review discoveries", copy: "Inspect duplicates and resolve uncertain classifications before planning.", done: analyzed > 0, page: "duplicates" },
    { label: "Propose organization", copy: "Build and inspect an explainable Conservative, Balanced, or Deep plan.", done: plans > 0, page: "organize" },
    { label: "Test before applying", copy: "Simulate the reviewed plan; enabling writes remains a deliberate separate decision.", done: false, page: "organize" },
  ] as const;
  return <section className="first-run-panel"><div className="section-heading"><div><span className="eyebrow">First-run guide</span><h2>From messy storage to understood library</h2><p>No cloud account, upload, or opaque background service is required.</p></div></div><ol>{steps.map((step, index) => <li className={step.done ? "first-run-step first-run-step--done" : "first-run-step"} key={step.label}><span>{step.done ? "✓" : index + 1}</span><div><strong>{step.label}</strong><p>{step.copy}</p></div>{"page" in step && <button className="button button--text button--mini" onClick={() => navigate(step.page)}>Open</button>}</li>)}</ol></section>;
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
