import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate, shortId } from "../format";
import type { LibraryView, QuarantineItem, SystemState } from "../types";

export function QuarantinePage() {
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [system, setSystem] = useState<SystemState>();
  const [selectedId, setSelectedId] = useState("");
  const [status, setStatus] = useState("");
  const [rootId, setRootId] = useState("");
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string>();
  const [confirmation, setConfirmation] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const selected = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);

  const load = useCallback(async (cursor?: string, append = false) => {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    if (status) query.set("status", status);
    if (rootId) query.set("rootId", rootId);
    if (search.trim()) query.set("search", search.trim());
    const [page, roots, state] = await Promise.all([
      api<{ items: QuarantineItem[]; nextCursor?: string }>("/api/quarantine?" + query.toString()),
      api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=true"),
      api<SystemState>("/api/system"),
    ]);
    setItems((current) => append ? [...current, ...page.items] : page.items);
    setNextCursor(page.nextCursor);
    setLibraries(roots.items);
    setSystem(state);
    if (!append) {
      setSelectedId((current) => page.items.some((item) => item.id === current) ? current : page.items[0]?.id ?? "");
    }
    setError(undefined);
  }, [rootId, search, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((value: unknown) => {
      setError(value instanceof Error ? value.message : "Quarantine could not be loaded.");
    }), 150);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function restore() {
    if (selected === undefined) return;
    setBusy(true);
    try {
      await post("/api/quarantine/" + encodeURIComponent(selected.id) + "/restore", {
        approvedBy: "local-web-user",
        confirmation,
      });
      await post("/api/worker/start").catch(() => undefined);
      setConfirming(false);
      setConfirmation("");
      setNotice("Restore queued. The worker will verify the quarantined copy and refuse any occupied destination.");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Restore could not be queued.");
    } finally {
      setBusy(false);
    }
  }

  const libraryName = (id: string): string =>
    libraries.find((library) => library.root.id === id)?.root.displayName ?? shortId(id);
  const restorePhrase = selected === undefined ? "" : "RESTORE " + selected.originalFileName;
  const restorable = selected?.status === "active" || selected?.status === "restore-blocked";

  return (
    <div className="page-stack">
      <header className="page-header page-header--split">
        <div>
          <span className="eyebrow">Recoverable removal</span>
          <h1>Quarantine & Recovery</h1>
          <p>User-visible copies removed by consolidation or source retirement stay inside the enrolled root with verified identity and an audit trail.</p>
        </div>
        <StatusBadge status={system?.mutationMode.mode === "live" ? "live" : "read-only"} />
      </header>
      {error && <div className="notice notice--error">{error}</div>}
      {notice && <div className="notice notice--success">{notice}</div>}

      <section className="filter-bar quarantine-filter">
        <label className="search-field"><span>Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Original filename or path" /></label>
        <label><span>Library</span><select value={rootId} onChange={(event) => setRootId(event.target.value)}><option value="">All libraries</option>{libraries.map((library) => <option value={library.root.id} key={library.root.id}>{library.root.displayName}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="restoring">Restoring</option><option value="restore-blocked">Restore blocked</option><option value="restored">Restored</option></select></label>
      </section>

      <div className="quarantine-layout">
        <section className="quarantine-list">
          {items.map((item) => <button className={"quarantine-row " + (item.id === selectedId ? "quarantine-row--active" : "")} key={item.id} onClick={() => setSelectedId(item.id)}><div><strong>{item.originalFileName}</strong><small>{libraryName(item.rootId)} · {formatDate(item.quarantinedAt)}</small></div><span>{formatBytes(item.byteLength)}</span><StatusBadge status={item.status} /></button>)}
          {items.length === 0 && <div className="quiet-card quiet-card--success">No quarantined copies match these filters.</div>}
          {nextCursor && <button className="button button--soft" onClick={() => void load(nextCursor, true)}>Load more</button>}
        </section>

        <section className="quarantine-detail">
          {selected === undefined && <div className="quiet-card">Select an item to inspect its recovery evidence.</div>}
          {selected !== undefined && <>
            <div className="section-heading"><div><span className="eyebrow">{selected.reason.replaceAll("-", " ")}</span><h2>{selected.originalFileName}</h2><p>{selected.originalRelativePath}</p></div><StatusBadge status={selected.status} /></div>
            <dl className="evidence-list">
              <div><dt>Original path</dt><dd><code>{selected.originalRelativePath}</code></dd></div>
              <div><dt>Quarantined path</dt><dd><code>{selected.quarantinedRelativePath}</code></dd></div>
              <div><dt>Content identity</dt><dd><code>sha256:{selected.digestHex}</code></dd></div>
              <div><dt>Size</dt><dd>{formatBytes(selected.byteLength)}</dd></div>
              <div><dt>Plan</dt><dd><code>{shortId(selected.planId)}</code></dd></div>
              <div><dt>Job</dt><dd><code>{shortId(selected.jobId)}</code></dd></div>
              {selected.restoredAt && <div><dt>Restored</dt><dd>{formatDate(selected.restoredAt)}</dd></div>}
            </dl>
            {selected.error && <div className="notice notice--error">{selected.error.code}: {selected.error.message}</div>}
            {restorable && <div className="decision-panel"><div><h3>Restore original path</h3><p>The worker verifies the quarantined content, checks the current root and write gates, and refuses a collision. A previously blocked restore may be retried after its cause is resolved.</p></div><button className="button button--primary" disabled={system?.mutationMode.mode !== "live"} onClick={() => { setConfirmation(""); setConfirming(true); }}>Review restore</button>{system?.mutationMode.mode !== "live" && <small>Enable FULL ORGANIZATION and library write access before restoring.</small>}</div>}
            {selected.status === "restored" && <div className="quiet-card quiet-card--success">This copy was restored and remains in the immutable transfer audit.</div>}
          </>}
        </section>
      </div>

      <ConfirmationDialog open={confirming} title="Restore quarantined copy?" confirmLabel="Queue verified restore" busy={busy} confirmDisabled={confirmation !== restorePhrase} onCancel={() => { setConfirming(false); setConfirmation(""); }} onConfirm={() => void restore()}>
        <p>The original path must be free. Local Librarian never overwrites a collision and verifies the SHA-256 identity before and after relocation.</p>
        <label><span>Type <code>{restorePhrase}</code></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      </ConfirmationDialog>
    </div>
  );
}
