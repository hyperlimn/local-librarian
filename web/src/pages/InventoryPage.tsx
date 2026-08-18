import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { InventoryTable } from "../components/InventoryTable";
import { ScanProgress } from "../components/ScanProgress";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate } from "../format";
import type { InventoryRecord, Job, LibraryView, Scan } from "../types";

interface InventoryPageResult {
  readonly items: InventoryRecord[];
  readonly nextCursor?: string;
}

export function InventoryPage() {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [rootId, setRootId] = useState("");
  const [summary, setSummary] = useState<LibraryView["summary"]>();
  const [scan, setScan] = useState<Scan>();
  const [job, setJob] = useState<Job>();
  const [records, setRecords] = useState<InventoryRecord[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [search, setSearch] = useState("");
  const [entryType, setEntryType] = useState("");
  const [extension, setExtension] = useState("");
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
    if (!rootId) { setRecords([]); return; }
    setLoading(true);
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    if (search.trim()) query.set("search", search.trim());
    if (entryType) query.set("type", entryType);
    if (extension.trim()) query.set("extension", extension.trim());
    try {
      const result = await api<InventoryPageResult>(`/api/libraries/${encodeURIComponent(rootId)}/inventory?${query}`);
      setRecords(result.items);
      setNextCursor(result.nextCursor);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Inventory could not be loaded.");
    } finally { setLoading(false); }
  }, [cursor, entryType, extension, rootId, search]);

  useEffect(() => { void loadLibraries().catch((value: unknown) => setError(value instanceof Error ? value.message : "Libraries could not be loaded.")); }, [loadLibraries]);
  useEffect(() => { setCursor(undefined); setCursorHistory([]); }, [rootId, search, entryType, extension]);
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
        <div><span className="eyebrow">Metadata observations</span><h1>Inventory</h1><p>Browse read-only filesystem observations. File contents are never opened.</p></div>
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
            <div className="section-heading"><div><h2>Inventory records</h2><p>Latest observations first, with server-side filters and cursor pagination.</p></div></div>
            <div className="filter-bar">
              <label className="search-field"><span className="sr-only">Search inventory</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search filename or relative path" /></label>
              <label><span className="sr-only">Entry type</span><select value={entryType} onChange={(event) => setEntryType(event.target.value)}><option value="">All types</option><option value="file">Files</option><option value="directory">Directories</option><option value="symbolic-link">Links</option><option value="other">Other</option></select></label>
              <label><span className="sr-only">Extension</span><input value={extension} onChange={(event) => setExtension(event.target.value)} placeholder="Extension, e.g. jpg" /></label>
            </div>
            <InventoryTable records={records} loading={loading} />
            <div className="pagination"><button className="button button--soft" disabled={cursorHistory.length === 0} onClick={previousPage}>Previous</button><span>Page {cursorHistory.length + 1}</span><button className="button button--soft" disabled={!nextCursor} onClick={nextPage}>Next</button></div>
          </section>
        </>
      )}
    </div>
  );
}

function SummaryItem({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
