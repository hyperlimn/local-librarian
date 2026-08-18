import { useCallback, useEffect, useState } from "react";

import { api, post } from "../api";
import { SafetyIndicator } from "../components/SafetyIndicator";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate, shortId } from "../format";
import type { LibraryView, WorkerStatus } from "../types";

interface SafetyData {
  readonly system: {
    version: string;
    binding: string;
    safetyStatus: string;
    filesystemExecution: string;
    fileMutation: string;
    databasePaths: Record<string, string>;
  };
  readonly libraries: LibraryView[];
  readonly worker: WorkerStatus;
}

export function SafetyPage() {
  const [data, setData] = useState<SafetyData>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setData(await api<SafetyData>("/api/safety")); setError(undefined); }
    catch (value) { setError(value instanceof Error ? value.message : "Safety state could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function startWorker() { try { await post("/api/worker/start"); await load(); } catch (value) { setError(value instanceof Error ? value.message : "Worker could not be started."); } }

  if (!data) return <div className="page-state"><div className="spinner" /><h1>Checking safety state</h1><p>{error ?? "Reading Local Librarian application state..."}</p></div>;
  const approved = data.libraries.filter((library) => library.root.approval.status === "approved");
  const revoked = data.libraries.filter((library) => library.root.approval.status === "revoked");
  return (
    <div className="page-stack">
      <header className="page-header"><div><span className="eyebrow">Boundaries and diagnostics</span><h1>Safety</h1><p>A compact view of the policies that keep Local Librarian read-only and locally contained.</p></div></header>
      {error && <div className="notice notice--error">{error}</div>}
      <SafetyIndicator />
      <section className="diagnostic-grid">
        <article className="diagnostic-card"><span className="eyebrow">Worker</span><div className="diagnostic-card__title"><h2>{data.worker.status}</h2><StatusBadge status={data.worker.status} /></div><dl><div><dt>Worker ID</dt><dd>{data.worker.workerId ? shortId(data.worker.workerId) : "-"}</dd></div><div><dt>PID</dt><dd>{data.worker.pid ?? "-"}</dd></div><div><dt>Heartbeat</dt><dd>{formatDate(data.worker.heartbeatAt)}</dd></div></dl>{(data.worker.status === "offline" || data.worker.status === "stale") && <button className="button button--primary" onClick={() => void startWorker()}>Start local worker</button>}</article>
        <article className="diagnostic-card"><span className="eyebrow">Runtime</span><h2>Local Librarian {data.system.version}</h2><dl><div><dt>Network binding</dt><dd>{data.system.binding}</dd></div><div><dt>Safety boundaries</dt><dd>{data.system.safetyStatus}</dd></div><div><dt>Filesystem execution</dt><dd>{data.system.filesystemExecution}</dd></div></dl></article>
      </section>
      <section><div className="section-heading"><h2>Approved roots</h2><span className="count-pill">{approved.length}</span></div><div className="root-list">{approved.map((library) => <RootRow key={library.root.id} library={library} />)}{approved.length === 0 && <div className="quiet-card">No roots are currently approved.</div>}</div></section>
      <section><div className="section-heading"><h2>Revoked roots</h2><span className="count-pill">{revoked.length}</span></div><div className="root-list">{revoked.map((library) => <RootRow key={library.root.id} library={library} />)}{revoked.length === 0 && <div className="quiet-card">No revoked roots.</div>}</div></section>
      <section className="paths-panel"><div><span className="eyebrow">Application-owned persistence</span><h2>Database paths</h2><p>These stores contain Local Librarian state. They are not generic filesystem endpoints.</p></div><dl>{Object.entries(data.system.databasePaths).map(([name, path]) => <div key={name}><dt>{name}</dt><dd><code>{path}</code></dd></div>)}</dl></section>
    </div>
  );
}

function RootRow({ library }: { readonly library: LibraryView }) {
  return <article className="root-row"><div><strong>{library.root.displayName}</strong><code>{library.root.displayPath}</code></div><div><small>{library.root.identity.volume.fileSystemTypeName ?? "filesystem unknown"}</small><StatusBadge status={library.root.approval.status} /></div></article>;
}
