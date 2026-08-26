import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { elapsed, formatBytes, formatDate, shortId } from "../format";
import type {
  LibraryView,
  PersistedReconciliation,
  PersistedReconciliationDelta,
  Scan,
} from "../types";

export function ScansPage() {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [rootId, setRootId] = useState("");
  const [scans, setScans] = useState<Scan[]>([]);
  const [baselineScanId, setBaselineScanId] = useState("");
  const [comparisonScanId, setComparisonScanId] = useState("");
  const [reconciliation, setReconciliation] = useState<PersistedReconciliation>();
  const [deltas, setDeltas] = useState<PersistedReconciliationDelta[]>([]);
  const [deltaKind, setDeltaKind] = useState("");
  const [deltaSearch, setDeltaSearch] = useState("");
  const [deltaCursor, setDeltaCursor] = useState<string>();
  const [deltaNextCursor, setDeltaNextCursor] = useState<string>();
  const [deltaHistory, setDeltaHistory] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string>();

  const names = useMemo(
    () => new Map(libraries.map((library) => [library.root.id, library.root.displayName])),
    [libraries],
  );
  const completedScans = useMemo(
    () => scans.filter((scan) => scan.status === "completed"),
    [scans],
  );

  const loadFoundations = useCallback(async () => {
    try {
      const roots = await api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=true");
      setLibraries(roots.items);
      const chosen = rootId || roots.items.find((item) => item.root.approval.status === "approved")?.root.id || "";
      if (!rootId && chosen) setRootId(chosen);
      if (!chosen) {
        setScans([]);
        setReconciliation(undefined);
        return;
      }
      const [scanPage, runPage] = await Promise.all([
        api<{ items: Scan[] }>("/api/scans?rootId=" + encodeURIComponent(chosen) + "&limit=250"),
        api<{ items: PersistedReconciliation[] }>("/api/reconciliations?rootId=" + encodeURIComponent(chosen) + "&limit=20"),
      ]);
      setScans(scanPage.items);
      setBaselineScanId((current) => scanPage.items.some((scan) => scan.id === current && scan.status === "completed")
        ? current
        : scanPage.items.filter((scan) => scan.status === "completed")[1]?.id ?? "");
      setComparisonScanId((current) => scanPage.items.some((scan) => scan.id === current && scan.status === "completed")
        ? current
        : scanPage.items.find((scan) => scan.status === "completed")?.id ?? "");
      setReconciliation((current) => current?.rootId === chosen ? current : runPage.items[0]);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Scan history could not be loaded.");
    }
  }, [rootId]);

  const loadDeltas = useCallback(async () => {
    if (reconciliation === undefined) {
      setDeltas([]);
      setDeltaNextCursor(undefined);
      return;
    }
    const query = new URLSearchParams({ limit: "100" });
    if (deltaCursor) query.set("cursor", deltaCursor);
    if (deltaKind) query.set("kind", deltaKind);
    if (deltaSearch.trim()) query.set("search", deltaSearch.trim());
    const page = await api<{ items: PersistedReconciliationDelta[]; nextCursor?: string }>(
      "/api/reconciliations/" + encodeURIComponent(reconciliation.id) + "/deltas?" + query.toString(),
    );
    setDeltas(page.items);
    setDeltaNextCursor(page.nextCursor);
  }, [deltaCursor, deltaKind, deltaSearch, reconciliation?.id]);

  useEffect(() => { void loadFoundations(); }, [loadFoundations]);
  useEffect(() => {
    setDeltaCursor(undefined);
    setDeltaHistory([]);
  }, [deltaKind, deltaSearch, reconciliation?.id]);
  useEffect(() => {
    void loadDeltas().catch((value: unknown) =>
      setError(value instanceof Error ? value.message : "Reconciliation changes could not be loaded."));
  }, [loadDeltas]);
  useEffect(() => {
    const id = reconciliation?.id;
    if (id === undefined) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const current = await api<PersistedReconciliation>("/api/reconciliations/" + encodeURIComponent(id));
        if (!stopped) setReconciliation(current);
      } catch {
        // A transient polling failure does not discard the last durable state.
      }
    };
    void refresh();
    if (reconciliation?.status === "completed" || reconciliation?.status === "failed" || reconciliation?.status === "cancelled") {
      return () => { stopped = true; };
    }
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [reconciliation?.id, reconciliation?.status]);
  useEffect(() => {
    if ((reconciliation?.processed ?? 0) > 0) void loadDeltas().catch(() => undefined);
  }, [loadDeltas, reconciliation?.processed]);

  async function compareScans() {
    if (!rootId || !baselineScanId || !comparisonScanId) return;
    setComparing(true);
    try {
      const run = await post<PersistedReconciliation>("/api/reconciliation", {
        rootId,
        baselineScanId,
        comparisonScanId,
      });
      setReconciliation(run);
      setDeltaCursor(undefined);
      setDeltaHistory([]);
      setDeltas([]);
      await post("/api/worker/start").catch(() => undefined);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "The reconciliation job could not be queued.");
    } finally {
      setComparing(false);
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (reconciliation?.jobId === undefined) return;
    try {
      await post("/api/jobs/" + encodeURIComponent(reconciliation.jobId) + "/" + action);
    } catch (value) {
      setError(value instanceof Error ? value.message : "The reconciliation control request failed.");
    }
  }

  function nextDeltaPage() {
    if (deltaNextCursor === undefined) return;
    setDeltaHistory((current) => [...current, deltaCursor ?? ""]);
    setDeltaCursor(deltaNextCursor);
  }

  function previousDeltaPage() {
    const previous = deltaHistory.at(-1);
    if (previous === undefined) return;
    setDeltaHistory((current) => current.slice(0, -1));
    setDeltaCursor(previous || undefined);
  }

  return (
    <div className="page-stack">
      <header className="page-header page-header--split">
        <div>
          <span className="eyebrow">Retained observations</span>
          <h1>Scans & Reconciliation</h1>
          <p>Compare immutable inventory snapshots in a bounded-memory background job. Differences are persisted, filtered, and paginated by SQLite.</p>
        </div>
        <label className="select-control">
          <span>Library</span>
          <select value={rootId} onChange={(event) => { setRootId(event.target.value); setReconciliation(undefined); }}>
            <option value="">Choose a library</option>
            {libraries.map((library) => <option value={library.root.id} key={library.root.id}>{library.root.displayName}</option>)}
          </select>
        </label>
      </header>
      {error && <div className="notice notice--error">{error}</div>}

      <section className="comparison-panel">
        <div>
          <span className="eyebrow">Durable comparison</span>
          <h2>What changed between scans?</h2>
          <p>Only retained catalog facts are compared. The browser never receives an unbounded result set.</p>
        </div>
        <div className="comparison-form">
          <label><span>Baseline</span><select value={baselineScanId} disabled={!rootId} onChange={(event) => setBaselineScanId(event.target.value)}><option value="">Choose an older scan</option>{completedScans.map((scan) => <option value={scan.id} key={scan.id}>{formatDate(scan.completedAt)} · {shortId(scan.id)}</option>)}</select></label>
          <label><span>Comparison</span><select value={comparisonScanId} disabled={!rootId} onChange={(event) => setComparisonScanId(event.target.value)}><option value="">Choose a newer scan</option>{completedScans.map((scan) => <option value={scan.id} key={scan.id}>{formatDate(scan.completedAt)} · {shortId(scan.id)}</option>)}</select></label>
          <button className="button button--soft" disabled={comparing || !rootId || !baselineScanId || !comparisonScanId || baselineScanId === comparisonScanId} onClick={() => void compareScans()}>{comparing ? "Queuing…" : "Compare snapshots"}</button>
        </div>
        {rootId && completedScans.length < 2 && <small>Two completed scans are required.</small>}
      </section>

      {reconciliation && <section className="comparison-results">
        <div className="section-heading">
          <div><span className="eyebrow">Persisted reconciliation</span><h2>{shortId(reconciliation.id)}</h2><p>Phase: {reconciliation.phase.replaceAll("-", " ")} · {reconciliation.processed.toLocaleString()} differences persisted</p></div>
          <div className="card-actions"><StatusBadge status={reconciliation.status} />{reconciliation.status === "running" && <button className="button button--soft button--mini" onClick={() => void control("pause")}>Pause</button>}{reconciliation.status === "paused" && <button className="button button--primary button--mini" onClick={() => void control("resume")}>Resume</button>}{["queued", "running", "paused"].includes(reconciliation.status) && <button className="button button--text button--mini button--danger-text" onClick={() => void control("cancel")}>Cancel</button>}</div>
        </div>
        {reconciliation.error && <div className="notice notice--error">{reconciliation.error.code}: {reconciliation.error.message}</div>}
        <div className="summary-band">
          <div><strong>{reconciliation.processed.toLocaleString()}</strong><span>Total changes</span></div>
          <div><strong>{reconciliation.counts.added.toLocaleString()}</strong><span>Added</span></div>
          <div><strong>{reconciliation.counts.missing.toLocaleString()}</strong><span>Missing</span></div>
          <div><strong>{reconciliation.counts.metadataChanged.toLocaleString()}</strong><span>Metadata changed</span></div>
        </div>
        <div className="filter-bar reconciliation-filter">
          <label className="search-field"><span>Search paths</span><input value={deltaSearch} onChange={(event) => setDeltaSearch(event.target.value)} /></label>
          <label><span>Change</span><select value={deltaKind} onChange={(event) => setDeltaKind(event.target.value)}><option value="">All changes</option><option value="added">Added</option><option value="missing">Missing</option><option value="metadata-changed">Metadata changed</option></select></label>
        </div>
        <div className="table-shell"><table className="inventory-table"><thead><tr><th>Path</th><th>Change</th><th>Details</th></tr></thead><tbody>{deltas.map((delta) => <tr key={delta.id}><td><code className="path-cell">{delta.relativePath}</code></td><td><StatusBadge status={delta.kind} /></td><td>{delta.changedFields.length > 0 ? delta.changedFields.join(", ") : delta.kind === "added" ? "Present only in comparison" : "Present only in baseline"}</td></tr>)}{deltas.length === 0 && <tr><td colSpan={3} className="empty-table">{reconciliation.status === "completed" ? "No changes match these filters." : "Differences will appear here as the worker persists them."}</td></tr>}</tbody></table></div>
        <div className="pagination"><button className="button button--ghost button--mini" disabled={deltaHistory.length === 0} onClick={previousDeltaPage}>Previous</button><span>Page {deltaHistory.length + 1} · at most 100 rows</span><button className="button button--ghost button--mini" disabled={deltaNextCursor === undefined} onClick={nextDeltaPage}>Next</button></div>
      </section>}

      <section className="scan-history-list">
        {scans.map((scan) => <article className="scan-history-card" key={scan.id}><div className="scan-history-card__head"><div><span className="eyebrow">{names.get(scan.rootId) ?? "Library"}</span><h2 title={scan.id}>{shortId(scan.id)}</h2></div><StatusBadge status={scan.status} /></div><div className="metric-row"><ScanMetric label="Files" value={scan.counts.filesDiscovered.toLocaleString()} /><ScanMetric label="Directories" value={scan.counts.directoriesVisited.toLocaleString()} /><ScanMetric label="Represented" value={formatBytes(scan.counts.bytesRepresented)} /><ScanMetric label="Skips / errors" value={scan.counts.skippedEntries.toLocaleString() + " / " + scan.counts.errorEntries.toLocaleString()} /></div><footer><span>Started {formatDate(scan.startedAt)}</span><span>Duration {elapsed(scan.startedAt, scan.completedAt)}</span><code title={scan.jobId}>{shortId(scan.jobId)}</code></footer>{scan.error && <p className="inline-error">{scan.error.code}: {scan.error.message}</p>}</article>)}
        {scans.length === 0 && <div className="quiet-card">No scan sessions have been recorded for this library.</div>}
      </section>
    </div>
  );
}

function ScanMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}
