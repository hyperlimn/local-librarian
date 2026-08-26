import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate } from "../format";
import type { NeedsReviewItem } from "../types";

const categories = ["Images", "Videos", "Audio", "Documents", "Archives", "Code", "Design", "Data", "Other"];

export function NeedsReviewPage({ navigate }: { readonly navigate: (page: string) => void }) {
  const [items, setItems] = useState<NeedsReviewItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [status, setStatus] = useState("open");
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("Documents");
  const [remember, setRemember] = useState(true);
  const [nextCursor, setNextCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const selected = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);

  const load = useCallback(async (cursor?: string, append = false) => {
    const query = new URLSearchParams({ limit: "50", status });
    if (cursor) query.set("cursor", cursor);
    if (reason) query.set("reason", reason);
    if (search.trim()) query.set("search", search.trim());
    const page = await api<{ items: NeedsReviewItem[]; nextCursor?: string }>(`/api/needs-review?${query}`);
    setItems((current) => append ? [...current, ...page.items] : page.items);
    setNextCursor(page.nextCursor);
    if (!append) setSelectedId((current) => page.items.some((item) => item.id === current) ? current : page.items[0]?.id || "");
    setError(undefined);
  }, [reason, search, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((value: unknown) => setError(value instanceof Error ? value.message : "Review items could not be loaded.")), 160);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function resolve() {
    if (!selected) return;
    setBusy(true);
    try {
      await post(`/api/needs-review/${encodeURIComponent(selected.id)}/resolve`, {
        status: "resolved",
        resolution: { category, decidedBy: "local-web-user" },
        rememberExtensionRule: remember,
      });
      setNotice(remember ? "Decision saved and the extension preference will be reused locally." : "Decision saved for this item.");
      await load();
    } catch (value) { setError(value instanceof Error ? value.message : "The review decision could not be saved."); }
    finally { setBusy(false); }
  }

  async function dismiss() {
    if (!selected) return;
    setBusy(true);
    try {
      await post(`/api/needs-review/${encodeURIComponent(selected.id)}/resolve`, {
        status: "dismissed",
        resolution: { reason: "dismissed-by-user" },
        rememberExtensionRule: false,
      });
      setNotice("Review item dismissed. No filesystem action was taken.");
      await load();
    } catch (value) { setError(value instanceof Error ? value.message : "The review item could not be dismissed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="page-stack">
      <header className="page-header"><div><span className="eyebrow">Honest uncertainty</span><h1>Needs Review</h1><p>Ambiguous classifications, keeper choices, stale sources, and unsafe destinations stop here instead of becoming blind actions.</p></div></header>
      {error && <div className="notice notice--error">{error}</div>}
      {notice && <div className="notice notice--success">{notice}</div>}
      <section className="filter-bar review-filter">
        <label className="search-field"><span>Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title or explanation" /></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="open">Open</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></label>
        <label><span>Reason</span><select value={reason} onChange={(event) => setReason(event.target.value)}><option value="">All reasons</option><option value="low-classification-confidence">Low confidence</option><option value="conflicting-metadata">Conflicting metadata</option><option value="duplicate-keeper-uncertain">Duplicate keeper</option><option value="unsafe-collision">Unsafe collision</option><option value="stale-source">Stale source</option><option value="unsupported-format">Unsupported format</option><option value="analysis-failed">Analysis failed</option></select></label>
      </section>
      <div className="review-layout">
        <section className="review-queue">
          {items.map((item) => <button key={item.id} className={`review-item ${item.id === selectedId ? "review-item--active" : ""}`} onClick={() => setSelectedId(item.id)}><span className="review-item__mark">?</span><div><strong>{item.title}</strong><small>{item.reason.replaceAll("-", " ")} · {formatDate(item.createdAt)}</small></div><StatusBadge status={item.status} /></button>)}
          {items.length === 0 && <div className="quiet-card quiet-card--success">No items match this queue. Local Librarian has no unresolved uncertainty in this view.</div>}
          {nextCursor && <button className="button button--soft" onClick={() => void load(nextCursor, true)}>Load more</button>}
        </section>
        <section className="review-detail">
          {!selected && <div className="quiet-card">Select an item to inspect its evidence.</div>}
          {selected && <><div className="section-heading"><div><span className="eyebrow">{selected.reason.replaceAll("-", " ")}</span><h2>{selected.title}</h2><p>{selected.description}</p></div><StatusBadge status={selected.status} /></div>
            <dl className="evidence-list">{Object.entries(selected.evidence).map(([key, value]) => <div key={key}><dt>{key.replaceAll(/([A-Z])/gu, " $1")}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl>
            {selected.status === "open" && selected.reason === "duplicate-keeper-uncertain" && <div className="decision-panel"><h3>Keeper decision required</h3><p>Inspect every verified path and select the copy or copies that should remain visible.</p><button className="button button--primary" onClick={() => navigate("duplicates")}>Open duplicate group</button></div>}
            {selected.status === "open" && selected.reason !== "duplicate-keeper-uncertain" && <div className="decision-panel"><div><h3>Resolve classification</h3><p>This creates local evidence only. Remembering the extension is a simple preference rule, not AI training.</p></div><label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label className="checkbox-control"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>Remember this extension rule</span></label><div className="card-actions"><button className="button button--primary" disabled={busy} onClick={() => void resolve()}>Save decision</button><button className="button button--text" disabled={busy} onClick={() => void dismiss()}>Dismiss</button></div></div>}
            {selected.status !== "open" && <div className="quiet-card">Resolved {formatDate(selected.resolvedAt)}. Stored decision: {JSON.stringify(selected.resolution ?? {})}</div>}
          </>}
        </section>
      </div>
    </div>
  );
}
