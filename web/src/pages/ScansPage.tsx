import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { elapsed, formatBytes, formatDate, shortId } from "../format";
import type {
  LibraryView,
  ReconciliationReport,
  Scan,
} from "../types";

export function ScansPage() {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [rootId, setRootId] = useState("");
  const [scans, setScans] = useState<Scan[]>([]);
  const [baselineScanId, setBaselineScanId] = useState("");
  const [comparisonScanId, setComparisonScanId] = useState("");
  const [report, setReport] = useState<ReconciliationReport>();
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
  const changeCounts = useMemo(() => ({
    added: report?.deltas.filter((delta) => delta.kind === "added").length ?? 0,
    missing: report?.deltas.filter((delta) => delta.kind === "missing").length ?? 0,
    changed: report?.deltas.filter((delta) => delta.kind === "metadata-changed").length ?? 0,
  }), [report]);

  const load = useCallback(async () => {
    try {
      const query = rootId
        ? `?rootId=${encodeURIComponent(rootId)}&limit=250`
        : "?limit=250";
      const [roots, page] = await Promise.all([
        api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=true"),
        api<{ items: Scan[] }>(`/api/scans${query}`),
      ]);
      setLibraries(roots.items);
      setScans(page.items);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Scan history could not be loaded.");
    }
  }, [rootId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setComparisonScanId(completedScans[0]?.id ?? "");
    setBaselineScanId(completedScans[1]?.id ?? "");
    setReport(undefined);
  }, [completedScans]);

  async function compareScans() {
    if (!rootId || !baselineScanId || !comparisonScanId) return;
    setComparing(true);
    try {
      setReport(await post<ReconciliationReport>("/api/reconciliation", {
        rootId,
        baselineScanId,
        comparisonScanId,
      }));
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "The scans could not be compared.");
    } finally {
      setComparing(false);
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header page-header--split">
        <div>
          <span className="eyebrow">Retained observations</span>
          <h1>Scan history</h1>
          <p>Every scan remains immutable. Compare completed snapshots to see files that appeared, disappeared, or changed metadata.</p>
        </div>
        <label className="select-control">
          <span>Library</span>
          <select value={rootId} onChange={(event) => setRootId(event.target.value)}>
            <option value="">All libraries</option>
            {libraries.map((library) => <option value={library.root.id} key={library.root.id}>{library.root.displayName}</option>)}
          </select>
        </label>
      </header>
      {error && <div className="notice notice--error">{error}</div>}

      <section className="comparison-panel">
        <div>
          <span className="eyebrow">Read-only reconciliation</span>
          <h2>What changed between scans?</h2>
          <p>This compares retained catalog metadata only. It never reads file contents or changes the filesystem.</p>
        </div>
        <div className="comparison-form">
          <label><span>Baseline</span><select value={baselineScanId} disabled={!rootId} onChange={(event) => { setBaselineScanId(event.target.value); setReport(undefined); }}><option value="">Choose an older scan</option>{completedScans.map((scan) => <option value={scan.id} key={scan.id}>{formatDate(scan.completedAt)} · {shortId(scan.id)}</option>)}</select></label>
          <label><span>Comparison</span><select value={comparisonScanId} disabled={!rootId} onChange={(event) => { setComparisonScanId(event.target.value); setReport(undefined); }}><option value="">Choose a newer scan</option>{completedScans.map((scan) => <option value={scan.id} key={scan.id}>{formatDate(scan.completedAt)} · {shortId(scan.id)}</option>)}</select></label>
          <button className="button button--soft" disabled={comparing || !rootId || !baselineScanId || !comparisonScanId || baselineScanId === comparisonScanId} onClick={() => void compareScans()}>{comparing ? "Comparing…" : "Compare snapshots"}</button>
        </div>
        {!rootId && <small>Select one library to compare its scans.</small>}
        {rootId && completedScans.length < 2 && <small>Two completed scans are required.</small>}
      </section>

      {report && <section className="comparison-results">
        <div className="summary-band">
          <div><strong>{report.deltas.length.toLocaleString()}</strong><span>Total changes</span></div>
          <div><strong>{changeCounts.added.toLocaleString()}</strong><span>Added</span></div>
          <div><strong>{changeCounts.missing.toLocaleString()}</strong><span>Missing</span></div>
          <div><strong>{changeCounts.changed.toLocaleString()}</strong><span>Metadata changed</span></div>
        </div>
        <div className="table-shell"><table className="inventory-table"><thead><tr><th>Path</th><th>Change</th><th>Details</th></tr></thead><tbody>{report.deltas.slice(0, 250).map((delta) => <tr key={`${delta.kind}:${delta.relativePath}`}><td><code className="path-cell">{delta.relativePath}</code></td><td><StatusBadge status={delta.kind} /></td><td>{delta.changedFields?.join(", ") ?? (delta.kind === "added" ? "Present only in comparison" : "Present only in baseline")}</td></tr>)}{report.deltas.length === 0 && <tr><td colSpan={3} className="empty-table">No comparable metadata changed.</td></tr>}</tbody></table></div>
        {report.deltas.length > 250 && <p className="comparison-note">Showing the first 250 of {report.deltas.length.toLocaleString()} changes.</p>}
      </section>}

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
