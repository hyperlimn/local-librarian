import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { elapsed, formatBytes, formatDate, shortId } from "../format";
import type { LibraryView, Scan } from "../types";

export function ScansPage() {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [rootId, setRootId] = useState("");
  const [scans, setScans] = useState<Scan[]>([]);
  const [error, setError] = useState<string>();
  const names = useMemo(() => new Map(libraries.map((library) => [library.root.id, library.root.displayName])), [libraries]);
  const load = useCallback(async () => {
    try {
      const query = rootId ? `?rootId=${encodeURIComponent(rootId)}&limit=250` : "?limit=250";
      const [roots, page] = await Promise.all([
        api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=true"),
        api<{ items: Scan[] }>(`/api/scans${query}`),
      ]);
      setLibraries(roots.items); setScans(page.items); setError(undefined);
    } catch (value) { setError(value instanceof Error ? value.message : "Scan history could not be loaded."); }
  }, [rootId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page-stack">
      <header className="page-header page-header--split"><div><span className="eyebrow">Retained observations</span><h1>Scan history</h1><p>Every scan session remains visible; no prior observations are reconciled or deleted.</p></div><label className="select-control"><span>Library</span><select value={rootId} onChange={(event) => setRootId(event.target.value)}><option value="">All libraries</option>{libraries.map((library) => <option value={library.root.id} key={library.root.id}>{library.root.displayName}</option>)}</select></label></header>
      {error && <div className="notice notice--error">{error}</div>}
      <section className="scan-history-list">
        {scans.map((scan) => <article className="scan-history-card" key={scan.id}><div className="scan-history-card__head"><div><span className="eyebrow">{names.get(scan.rootId) ?? "Library"}</span><h2 title={scan.id}>{shortId(scan.id)}</h2></div><StatusBadge status={scan.status} /></div><div className="metric-row"><ScanMetric label="Files" value={scan.counts.filesDiscovered.toLocaleString()} /><ScanMetric label="Directories" value={scan.counts.directoriesVisited.toLocaleString()} /><ScanMetric label="Represented" value={formatBytes(scan.counts.bytesRepresented)} /><ScanMetric label="Skips / errors" value={`${scan.counts.skippedEntries.toLocaleString()} / ${scan.counts.errorEntries.toLocaleString()}`} /></div><footer><span>Started {formatDate(scan.startedAt)}</span><span>Duration {elapsed(scan.startedAt, scan.completedAt)}</span><code title={scan.jobId}>{shortId(scan.jobId)}</code></footer>{scan.error && <p className="inline-error">{scan.error.code}: {scan.error.message}</p>}</article>)}
        {scans.length === 0 && <div className="quiet-card">No scan sessions have been recorded.</div>}
      </section>
    </div>
  );
}

function ScanMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}
