import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { InventoryTable } from "../components/InventoryTable";
import { ScanProgress } from "../components/ScanProgress";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate } from "../format";
import type { EnrichedInventoryItem, InventoryRecord, Job, LibraryView, Scan } from "../types";

interface InventoryPageResult<T> {
  readonly items: T[];
  readonly nextCursor?: string;
}

type InventoryView = "understood" | "filesystem";

export function InventoryPage() {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [rootId, setRootId] = useState("");
  const [summary, setSummary] = useState<LibraryView["summary"]>();
  const [scan, setScan] = useState<Scan>();
  const [job, setJob] = useState<Job>();
  const [records, setRecords] = useState<InventoryRecord[]>([]);
  const [understoodRecords, setUnderstoodRecords] = useState<EnrichedInventoryItem[]>([]);
  const [view, setView] = useState<InventoryView>("understood");
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [search, setSearch] = useState("");
  const [entryType, setEntryType] = useState("");
  const [extension, setExtension] = useState("");
  const [category, setCategory] = useState("");
  const [mimeType, setMimeType] = useState("");
  const [duplicateState, setDuplicateState] = useState("");
  const [hashState, setHashState] = useState("");
  const [analysisState, setAnalysisState] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [minimumMegabytes, setMinimumMegabytes] = useState("");
  const [maximumMegabytes, setMaximumMegabytes] = useState("");
  const [modifiedAfter, setModifiedAfter] = useState("");
  const [modifiedBefore, setModifiedBefore] = useState("");
  const [captureAfter, setCaptureAfter] = useState("");
  const [captureBefore, setCaptureBefore] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const selectedLibrary = useMemo(
    () => libraries.find((library) => library.root.id === rootId),
    [libraries, rootId],
  );

  const loadLibraries = useCallback(async () => {
    const result = await api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=true");
    setLibraries(result.items);
    setRootId((current) => current || result.items[0]?.root.id || "");
  }, []);

  const loadRoot = useCallback(async () => {
    if (!rootId) return;
    const [summaryResult, scansResult] = await Promise.all([
      api<LibraryView["summary"]>(`/api/libraries/${encodeURIComponent(rootId)}/summary`),
      api<{ items: Scan[] }>(`/api/scans?rootId=${encodeURIComponent(rootId)}&limit=1`),
    ]);
    setSummary(summaryResult);
    const latest = scansResult.items[0];
    setScan(latest);
    if (latest !== undefined) {
      setJob(await api<Job>(`/api/jobs/${encodeURIComponent(latest.jobId)}`));
    } else {
      setJob(undefined);
    }
  }, [rootId]);

  const loadRecords = useCallback(async () => {
    if (!rootId) { setRecords([]); setUnderstoodRecords([]); return; }
    setLoading(true);
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    if (search.trim()) query.set("search", search.trim());
    if (extension.trim()) query.set("extension", extension.trim());
    if (view === "filesystem" && entryType) query.set("type", entryType);
    if (view === "understood") {
      if (category.trim()) query.set("category", category.trim());
      if (mimeType.trim()) query.set("mimeType", mimeType.trim());
      if (duplicateState) query.set("duplicateState", duplicateState);
      if (hashState) query.set("hashState", hashState);
      if (analysisState) query.set("analysisState", analysisState);
      if (needsReview) query.set("needsReview", "true");
      if (minimumMegabytes) query.set("minimumBytes", String(Math.round(Number(minimumMegabytes) * 1_048_576)));
      if (maximumMegabytes) query.set("maximumBytes", String(Math.round(Number(maximumMegabytes) * 1_048_576)));
      if (modifiedAfter) query.set("modifiedAfter", modifiedAfter);
      if (modifiedBefore) query.set("modifiedBefore", modifiedBefore);
      if (captureAfter) query.set("captureAfter", captureAfter);
      if (captureBefore) query.set("captureBefore", captureBefore);
    }
    try {
      if (view === "understood") {
        const result = await api<InventoryPageResult<EnrichedInventoryItem>>(`/api/libraries/${encodeURIComponent(rootId)}/search?${query}`);
        setUnderstoodRecords(result.items);
        setRecords([]);
        setNextCursor(result.nextCursor);
      } else {
        const result = await api<InventoryPageResult<InventoryRecord>>(`/api/libraries/${encodeURIComponent(rootId)}/inventory?${query}`);
        setRecords(result.items);
        setUnderstoodRecords([]);
        setNextCursor(result.nextCursor);
      }
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Inventory could not be loaded.");
    } finally { setLoading(false); }
  }, [analysisState, captureAfter, captureBefore, category, cursor, duplicateState, entryType, extension, hashState, maximumMegabytes, mimeType, minimumMegabytes, modifiedAfter, modifiedBefore, needsReview, rootId, search, view]);

  useEffect(() => { void loadLibraries().catch((value: unknown) => setError(value instanceof Error ? value.message : "Libraries could not be loaded.")); }, [loadLibraries]);
  useEffect(() => { setCursor(undefined); setCursorHistory([]); }, [analysisState, captureAfter, captureBefore, category, duplicateState, entryType, extension, hashState, maximumMegabytes, mimeType, minimumMegabytes, modifiedAfter, modifiedBefore, needsReview, rootId, search, view]);
  useEffect(() => { void loadRecords(); }, [loadRecords]);
  useEffect(() => {
    void loadRoot().catch((value: unknown) => setError(value instanceof Error ? value.message : "Scan status could not be loaded."));
    const timer = window.setInterval(() => void loadRoot(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadRoot]);

  async function startScan() {
    if (!rootId) return;
    try {
      await post(`/api/libraries/${encodeURIComponent(rootId)}/scans`);
      await loadRoot();
    } catch (value) { setError(value instanceof Error ? value.message : "Scan submission failed."); }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!job) return;
    try {
      await post(`/api/jobs/${encodeURIComponent(job.id)}/${action}`);
      await loadRoot();
    } catch (value) { setError(value instanceof Error ? value.message : `Could not ${action} scan.`); }
  }

  function nextPage() {
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, cursor ?? ""]);
    setCursor(nextCursor);
  }

  function previousPage() {
    const previous = cursorHistory.at(-1);
    setCursorHistory((history) => history.slice(0, -1));
    setCursor(previous || undefined);
  }

  return (
    <div className="page-stack">
      <header className="page-header page-header--split">
        <div><span className="eyebrow">Searchable local catalog</span><h1>Inventory</h1><p>Browse filesystem observations or the progressively enriched understanding layer. Content is opened only by explicitly requested local analysis jobs.</p></div>
        <label className="select-control"><span>Library</span><select value={rootId} onChange={(event) => setRootId(event.target.value)}>{libraries.map((library) => <option key={library.root.id} value={library.root.id}>{library.root.displayName}</option>)}</select></label>
      </header>
      {error && <div className="notice notice--error">{error}</div>}
      {!selectedLibrary && !loading && <div className="empty-card"><h3>No enrolled libraries</h3><p>Enroll and approve a library before starting an inventory scan.</p></div>}

      {selectedLibrary && (
        <>
          <section className="inventory-toolbar">
            <div><span className="eyebrow">Selected boundary</span><h2>{selectedLibrary.root.displayName}</h2><p>{selectedLibrary.root.displayPath}</p></div>
            <div className="card-actions">
              {selectedLibrary.root.approval.status === "approved" && <button className="button button--primary" onClick={() => void startScan()}>Start scan</button>}
              {job?.status === "running" && <button className="button button--soft" onClick={() => void control("pause")}>Pause</button>}
              {job?.status === "paused" && <button className="button button--primary" onClick={() => void control("resume")}>Resume</button>}
              {(job?.status === "queued" || job?.status === "running" || job?.status === "paused") && <button className="button button--text button--danger-text" onClick={() => void control("cancel")}>Cancel</button>}
              <StatusBadge status={selectedLibrary.root.approval.status} />
            </div>
          </section>

          {scan && <ScanProgress scan={scan} progress={job?.progress} />}

          <section className="summary-band">
            <SummaryItem label="Files" value={summary?.latestScan?.counts.filesDiscovered.toLocaleString() ?? "-"} />
            <SummaryItem label="Directories" value={summary?.latestScan?.counts.directoriesVisited.toLocaleString() ?? "-"} />
            <SummaryItem label="Represented" value={formatBytes(summary?.latestScan?.counts.bytesRepresented)} />
            <SummaryItem label="Last observed" value={formatDate(summary?.latestScan?.completedAt ?? summary?.latestScan?.startedAt)} />
            <SummaryItem label="Scans retained" value={String(summary?.retainedScanCount ?? 0)} />
          </section>

          <section>
            <div className="section-heading"><div><h2>{view === "understood" ? "Understood files" : "Filesystem observations"}</h2><p>Every filter runs in SQLite; the browser receives at most 100 rows at a time.</p></div><div className="segmented-control"><button className={view === "understood" ? "button button--soft segmented-control--active" : "button button--ghost"} onClick={() => setView("understood")}>Understood</button><button className={view === "filesystem" ? "button button--soft segmented-control--active" : "button button--ghost"} onClick={() => setView("filesystem")}>Filesystem facts</button></div></div>
            <div className="filter-bar">
              <label className="search-field"><span className="sr-only">Search inventory</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search filename or relative path" /></label>
              {view === "filesystem" && <label><span className="sr-only">Entry type</span><select value={entryType} onChange={(event) => setEntryType(event.target.value)}><option value="">All types</option><option value="file">Files</option><option value="directory">Directories</option><option value="symbolic-link">Links</option><option value="other">Other</option></select></label>}
              <label><span className="sr-only">Extension</span><input value={extension} onChange={(event) => setExtension(event.target.value)} placeholder="Extension, e.g. jpg" /></label>
              {view === "understood" && <><label><span className="sr-only">Category</span><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Category" /></label><label><span className="sr-only">MIME type</span><input value={mimeType} onChange={(event) => setMimeType(event.target.value)} placeholder="MIME/type" /></label></>}
            </div>
            {view === "understood" && <details className="advanced-filters"><summary>More local catalog filters</summary><div>
              <label><span>Duplicate state</span><select value={duplicateState} onChange={(event) => setDuplicateState(event.target.value)}><option value="">Any</option><option value="candidate">Candidate</option><option value="exact">Exact</option><option value="none">None</option></select></label>
              <label><span>Hash state</span><select value={hashState} onChange={(event) => setHashState(event.target.value)}><option value="">Any</option><option value="verified">Verified</option><option value="reused">Reused</option><option value="not-requested">Not requested</option></select></label>
              <label><span>Analysis state</span><select value={analysisState} onChange={(event) => setAnalysisState(event.target.value)}><option value="">Any</option><option value="analyzed">Analyzed</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="not-analyzed">Not analyzed</option></select></label>
              <label><span>Minimum MB</span><input type="number" min="0" value={minimumMegabytes} onChange={(event) => setMinimumMegabytes(event.target.value)} /></label>
              <label><span>Maximum MB</span><input type="number" min="0" value={maximumMegabytes} onChange={(event) => setMaximumMegabytes(event.target.value)} /></label>
              <label><span>Modified after</span><input type="date" value={modifiedAfter} onChange={(event) => setModifiedAfter(event.target.value)} /></label>
              <label><span>Modified before</span><input type="date" value={modifiedBefore} onChange={(event) => setModifiedBefore(event.target.value)} /></label>
              <label><span>Captured after</span><input type="date" value={captureAfter} onChange={(event) => setCaptureAfter(event.target.value)} /></label>
              <label><span>Captured before</span><input type="date" value={captureBefore} onChange={(event) => setCaptureBefore(event.target.value)} /></label>
              <label className="checkbox-control"><input type="checkbox" checked={needsReview} onChange={(event) => setNeedsReview(event.target.checked)} /><span>Needs Review only</span></label>
            </div></details>}
            {view === "understood" ? <UnderstoodInventoryTable records={understoodRecords} loading={loading} /> : <InventoryTable records={records} loading={loading} />}
            <div className="pagination"><button className="button button--soft" disabled={cursorHistory.length === 0} onClick={previousPage}>Previous</button><span>Page {cursorHistory.length + 1} · at most 100 rows</span><button className="button button--soft" disabled={!nextCursor} onClick={nextPage}>Next</button></div>
          </section>
        </>
      )}
    </div>
  );
}

function UnderstoodInventoryTable({ records, loading }: { readonly records: readonly EnrichedInventoryItem[]; readonly loading: boolean }) {
  return <div className="table-shell"><table className="inventory-table understood-table"><thead><tr><th>Name / path</th><th>Category</th><th>Type</th><th>Identity</th><th>Relationships</th><th className="numeric">Size</th><th>Dates</th></tr></thead><tbody>{records.map((record) => <tr key={record.recordId} className={record.needsReview ? "row--attention" : ""}><td><div className="file-cell"><span className="file-icon">F</span><span><strong>{record.name}</strong><small title={record.relativePath}>{record.relativePath}</small></span></div></td><td>{record.category ?? "Unclassified"}{record.needsReview && <small className="review-inline">Needs Review</small>}</td><td><code>{record.mimeType ?? record.extension ?? "unknown"}</code><small>{record.analysisState.replaceAll("-", " ")}</small></td><td><StatusBadge status={record.duplicateState} /><small>{record.hashState.replaceAll("-", " ")}</small></td><td>{record.semanticGroups.length === 0 ? "—" : record.semanticGroups.map((group) => <span className="group-chip" title={group.kind} key={group.id}>{group.displayName}</span>)}</td><td className="numeric">{formatBytes(record.byteLength)}</td><td><small>Modified {formatDate(record.modifiedAt)}</small>{record.captureAt && <small>Captured {formatDate(record.captureAt)}</small>}</td></tr>)}{!loading && records.length === 0 && <tr><td colSpan={7} className="empty-table">No understood files match these filters. Run progressive analysis to add content facts.</td></tr>}{loading && <tr><td colSpan={7} className="empty-table">Searching the local catalog…</td></tr>}</tbody></table></div>;
}

function SummaryItem({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
