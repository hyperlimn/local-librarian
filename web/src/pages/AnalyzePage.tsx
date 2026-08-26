import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate } from "../format";
import type { AnalysisStage, AnalysisStatus, Job, LibraryView, ResourceSettings } from "../types";

const stageCopy: Record<AnalysisStage["stage"], { title: string; copy: string }> = {
  "candidate-duplicates": {
    title: "Duplicate candidates",
    copy: "Groups equal-size files without reading contents, so useful results arrive quickly.",
  },
  "content-identity": {
    title: "Content identity",
    copy: "Selectively computes and reuses SHA-256 identities for candidates or requested files.",
  },
  metadata: {
    title: "Local metadata",
    copy: "Reads format metadata locally through isolated image, media, document, audio, and archive adapters.",
  },
  relationships: {
    title: "Relationships",
    copy: "Finds projects, albums, sidecars, and RAW/rendered pairs from deterministic context.",
  },
  classification: {
    title: "Classification",
    copy: "Combines type, metadata, remembered rules, and optional local-model evidence.",
  },
};

export function AnalyzePage() {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [rootId, setRootId] = useState("");
  const [status, setStatus] = useState<AnalysisStatus>();
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [preferredDepth, setPreferredDepth] = useState<ResourceSettings["analysisDepth"]>("standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selected = useMemo(() => libraries.find((library) => library.root.id === rootId), [libraries, rootId]);

  const load = useCallback(async () => {
    const libraryPage = await api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=false");
    setLibraries(libraryPage.items);
    const chosen = rootId || libraryPage.items[0]?.root.id || "";
    if (!rootId && chosen) setRootId(chosen);
    if (!chosen) { setStatus(undefined); return; }
    const next = await api<AnalysisStatus>(`/api/libraries/${encodeURIComponent(chosen)}/analysis`);
    setStatus(next);
    const active = next.stages.filter((stage) => stage.jobId !== undefined);
    const loaded = await Promise.all(active.map(async (stage) => [
      stage.jobId!, await api<Job>(`/api/jobs/${encodeURIComponent(stage.jobId!)}`),
    ] as const).map((promise) => promise.catch(() => undefined)));
    setJobs(Object.fromEntries(loaded.filter((item): item is readonly [string, Job] => item !== undefined)));
    setError(undefined);
  }, [rootId]);

  useEffect(() => {
    void load().catch((value: unknown) => setError(value instanceof Error ? value.message : "Analysis status is unavailable."));
    const timer = window.setInterval(() => void load().catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void api<ResourceSettings>("/api/settings/resources")
      .then((settings) => setPreferredDepth(settings.analysisDepth))
      .catch(() => undefined);
  }, []);

  async function start(depth: "essentials" | "standard" | "deep") {
    if (!rootId) return;
    setBusy(true);
    try {
      const stages = depth === "essentials"
        ? ["candidate-duplicates", "content-identity"]
        : depth === "standard"
          ? ["candidate-duplicates", "content-identity", "metadata", "classification", "relationships"]
          : ["candidate-duplicates", "content-identity", "metadata", "classification", "relationships"];
      await post(`/api/libraries/${encodeURIComponent(rootId)}/analysis`, {
        requestedBy: "local-web-user",
        stages,
        hashScope: depth === "deep" ? "all" : "duplicate-candidates",
      });
      await post("/api/worker/start").catch(() => undefined);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Analysis could not be queued.");
    } finally { setBusy(false); }
  }

  async function control(jobId: string, action: "pause" | "resume" | "cancel") {
    try { await post(`/api/jobs/${encodeURIComponent(jobId)}/${action}`); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : `Could not ${action} analysis.`); }
  }

  return (
    <div className="page-stack">
      <header className="page-header page-header--split">
        <div><span className="eyebrow">Progressive local understanding</span><h1>Analyze</h1><p>Useful facts arrive in stages. Expensive content reads run as durable local jobs and can be paused or resumed.</p></div>
        <label className="select-control"><span>Library</span><select value={rootId} onChange={(event) => setRootId(event.target.value)}>{libraries.map((library) => <option value={library.root.id} key={library.root.id}>{library.root.displayName}</option>)}</select></label>
      </header>
      {error && <div className="notice notice--error">{error}</div>}
      {!selected && <div className="empty-card"><h3>Inventory a library first</h3><p>Analysis is attached to an immutable completed inventory scan.</p></div>}
      {selected && (
        <>
          <section className="analysis-launch">
            <div><span className="eyebrow">Choose depth</span><h2>{selected.root.displayName}</h2><p>No cloud service is contacted. Standard analyzes likely duplicate contents plus local metadata and relationships; Deep computes identities for every observed file.</p></div>
            <div className="strategy-grid">
              <DepthButton title="Essentials" copy="Duplicate candidates and selective identity" recommended={preferredDepth === "essentials"} disabled={busy} onClick={() => void start("essentials")} />
              <DepthButton title="Standard" copy="Metadata and relationships" recommended={preferredDepth === "standard"} disabled={busy} onClick={() => void start("standard")} />
              <DepthButton title="Deep" copy="Hash every file and run all local stages" recommended={preferredDepth === "deep"} disabled={busy} onClick={() => void start("deep")} />
            </div>
          </section>
          <section className="summary-band summary-band--analysis">
            <Summary label="Observed files" value={status?.totals.files.toLocaleString() ?? "—"} />
            <Summary label="Analyzed" value={status?.totals.analyzed.toLocaleString() ?? "—"} />
            <Summary label="Identity verified" value={status?.totals.hashesVerified.toLocaleString() ?? "—"} />
            <Summary label="Identity reused" value={status?.totals.hashesReused.toLocaleString() ?? "—"} />
            <Summary label="Needs Review" value={status?.totals.needsReview.toLocaleString() ?? "—"} />
          </section>
          <section className="stage-list">
            {(Object.keys(stageCopy) as AnalysisStage["stage"][]).map((name) => {
              const stage = status?.stages.find((candidate) => candidate.stage === name);
              const job = stage?.jobId === undefined ? undefined : jobs[stage.jobId];
              const progress = job?.progress;
              const total = progress?.totalUnits ?? stage?.total;
              const completed = progress?.completedUnits ?? stage?.processed ?? 0;
              const percent = progress?.percent ?? (total && total > 0 ? Math.floor((completed / total) * 100) : undefined);
              return (
                <article className="stage-card" key={name}>
                  <div className="stage-card__number">{String((Object.keys(stageCopy) as string[]).indexOf(name) + 1).padStart(2, "0")}</div>
                  <div className="stage-card__body"><div className="stage-card__heading"><div><h3>{stageCopy[name].title}</h3><p>{stageCopy[name].copy}</p></div><StatusBadge status={job?.status ?? stage?.status ?? "not-started"} /></div>
                    <div className="progress-track"><span style={{ width: `${percent ?? 0}%` }} /></div>
                    <small>{progress?.message ?? (stage ? `${completed.toLocaleString()}${total === undefined ? "" : ` / ${total.toLocaleString()}`} · updated ${formatDate(stage.updatedAt)}` : "Not requested for this scan")}</small>
                    {stage?.error && <div className="inline-error">{stage.error.message}</div>}
                  </div>
                  {job && <div className="stage-card__actions">{job.status === "running" && <button className="button button--soft button--mini" onClick={() => void control(job.id, "pause")}>Pause</button>}{job.status === "paused" && <button className="button button--primary button--mini" onClick={() => void control(job.id, "resume")}>Resume</button>}{["queued", "running", "paused"].includes(job.status) && <button className="button button--text button--mini button--danger-text" onClick={() => void control(job.id, "cancel")}>Cancel</button>}</div>}
                </article>
              );
            })}
          </section>
          {status && <div className="quiet-card">This scan currently represents {formatBytes(selected.summary.latestScan?.counts.bytesRepresented)}. Relationship groups found: {status.totals.semanticGroups.toLocaleString()}.</div>}
        </>
      )}
    </div>
  );
}

function DepthButton({ title, copy, recommended = false, disabled, onClick }: {
  readonly title: string; readonly copy: string; readonly recommended?: boolean;
  readonly disabled: boolean; readonly onClick: () => void;
}) {
  return <button className={`strategy-card ${recommended ? "strategy-card--recommended" : ""}`} disabled={disabled} onClick={onClick}>{recommended && <span>Recommended</span>}<strong>{title}</strong><small>{copy}</small></button>;
}

function Summary({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
