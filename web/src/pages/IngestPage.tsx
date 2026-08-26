import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate } from "../format";
import type { LibraryView, Proposal, Root, TransferItem, TransferPlan } from "../types";

type PendingDialog = "enrollment" | "retirement" | "approval" | undefined;

export function IngestPage({ navigate }: { readonly navigate: (page: string) => void }) {
  const [sources, setSources] = useState<Root[]>([]);
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [plans, setPlans] = useState<TransferPlan[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [items, setItems] = useState<TransferItem[]>([]);
  const [itemNextCursor, setItemNextCursor] = useState<string>();
  const [sourcePath, setSourcePath] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceKind, setSourceKind] = useState<Root["kind"]>("folder");
  const [proposal, setProposal] = useState<Proposal>();
  const [targetDirectory, setTargetDirectory] = useState("Imported");
  const [preserveFolders, setPreserveFolders] = useState(true);
  const [retireSource, setRetireSource] = useState(false);
  const [pending, setPending] = useState<PendingDialog>();
  const [confirmation, setConfirmation] = useState("");
  const [resolutionPaths, setResolutionPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const selectedSource = useMemo(() => sources.find((source) => source.id === sourceId), [sourceId, sources]);
  const selectedPlan = useMemo(() => plans.find((plan) => plan.id === selectedPlanId), [plans, selectedPlanId]);

  const loadFoundations = useCallback(async () => {
    const [sourcePage, libraryPage, planPage] = await Promise.all([
      api<{ items: Root[] }>("/api/ingest/sources?includeRevoked=false"),
      api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=false"),
      api<{ items: TransferPlan[] }>("/api/transfers?kind=ingest&limit=50"),
    ]);
    setSources(sourcePage.items);
    setLibraries(libraryPage.items);
    setPlans(planPage.items);
    setSourceId((current) => sourcePage.items.some((source) => source.id === current) ? current : sourcePage.items[0]?.id || "");
    setDestinationId((current) => libraryPage.items.some((library) => library.root.id === current) ? current : libraryPage.items[0]?.root.id || "");
    setSelectedPlanId((current) => planPage.items.some((plan) => plan.id === current) ? current : planPage.items[0]?.id || "");
    setError(undefined);
  }, []);

  const loadItems = useCallback(async (cursor?: string, append = false) => {
    if (!selectedPlanId) { setItems([]); return; }
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await api<{ items: TransferItem[]; nextCursor?: string }>(`/api/transfers/${encodeURIComponent(selectedPlanId)}/items?${query}`);
    setItems((current) => append ? [...current, ...page.items] : page.items);
    setItemNextCursor(page.nextCursor);
    if (!append) setResolutionPaths(Object.fromEntries(page.items.map((item) => [item.id, item.destinationRelativePath ?? "Imported/Needs Review/" + item.originalFileName])));
  }, [selectedPlanId]);

  useEffect(() => {
    void loadFoundations().catch((value: unknown) => setError(value instanceof Error ? value.message : "Ingest state could not be loaded."));
    const timer = window.setInterval(() => void loadFoundations().catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [loadFoundations]);
  useEffect(() => { void loadItems().catch((value: unknown) => setError(value instanceof Error ? value.message : "Ingest items could not be loaded.")); }, [loadItems, plans]);
  useEffect(() => { setRetireSource(false); }, [sourceId]);

  async function proposeSource() {
    setBusy(true);
    try {
      const created = await post<Proposal>("/api/ingest/sources/proposals", {
        path: sourcePath,
        displayName: sourceName,
        kind: sourceKind,
      });
      setProposal(created);
      setPending("enrollment");
    } catch (value) { setError(value instanceof Error ? value.message : "The ingest source could not be inspected."); }
    finally { setBusy(false); }
  }

  async function approveSource() {
    if (!proposal) return;
    setBusy(true);
    try {
      await post(`/api/enrollment/proposals/${encodeURIComponent(proposal.proposalId)}/approve`, { approvedBy: "local-web-user" });
      setProposal(undefined); setPending(undefined); setSourcePath(""); setSourceName("");
      setNotice("Ingest source enrolled read-only. Source retirement remains disabled.");
      await loadFoundations();
    } catch (value) { setError(value instanceof Error ? value.message : "The source could not be approved."); }
    finally { setBusy(false); }
  }

  async function enableRetirement() {
    if (!sourceId) return;
    setBusy(true);
    try {
      await post(`/api/ingest/sources/${encodeURIComponent(sourceId)}/retirement-access`, {
        allowWrites: true,
        allowSourceRetirement: true,
        approvedBy: "local-web-user",
        confirmation,
      });
      setPending(undefined); setConfirmation(""); setRetireSource(true);
      setNotice("Source retirement enabled for this source. Each ingest plan still needs explicit retirement approval.");
      await loadFoundations();
    } catch (value) { setError(value instanceof Error ? value.message : "Source retirement could not be enabled."); }
    finally { setBusy(false); }
  }

  async function createPlan() {
    if (!sourceId || !destinationId) return;
    setBusy(true);
    try {
      const plan = await post<TransferPlan>("/api/ingest/plans", {
        sourceRootId: sourceId,
        destinationRootId: destinationId,
        targetDirectory,
        preserveSourceFolders: preserveFolders,
        retireSource,
        requestedBy: "local-web-user",
      });
      await post("/api/worker/start").catch(() => undefined);
      setSelectedPlanId(plan.id);
      setNotice("Source analysis queued. You can close this browser; the local worker keeps going.");
      await loadFoundations();
    } catch (value) { setError(value instanceof Error ? value.message : "The ingest analysis could not be queued."); }
    finally { setBusy(false); }
  }

  async function resolveItem(item: TransferItem) {
    setBusy(true);
    try {
      await post(`/api/transfers/${encodeURIComponent(item.planId)}/items/${encodeURIComponent(item.id)}/resolve`, {
        destinationRelativePath: resolutionPaths[item.id],
      });
      await Promise.all([loadFoundations(), loadItems()]);
      setNotice("Destination decision saved locally.");
    } catch (value) { setError(value instanceof Error ? value.message : "The destination could not be saved."); }
    finally { setBusy(false); }
  }

  async function approvePlan() {
    if (!selectedPlan) return;
    setBusy(true);
    try {
      await post(`/api/transfers/${encodeURIComponent(selectedPlan.id)}/approve`, {
        approvedBy: "local-web-user",
        confirmation,
      });
      await post("/api/worker/start").catch(() => undefined);
      setPending(undefined); setConfirmation("");
      setNotice("Verified import queued. The source is preserved unless this plan explicitly retires it to quarantine.");
      navigate("jobs");
    } catch (value) { setError(value instanceof Error ? value.message : "The ingest plan could not be approved."); }
    finally { setBusy(false); }
  }

  const approvalPhrase = selectedPlan === undefined
    ? ""
    : selectedPlan.retireSource
      ? `IMPORT ${selectedPlan.counts.ready} FILES AND QUARANTINE SOURCES`
      : `IMPORT ${selectedPlan.counts.ready} FILES`;

  return (
    <div className="page-stack">
      <header className="page-header"><div><span className="eyebrow">Verified import</span><h1>Ingest</h1><p>Choose an explicitly enrolled source, understand it locally, detect material already present, and copy verified files into a library.</p></div></header>
      {error && <div className="notice notice--error">{error}</div>}
      {notice && <div className="notice notice--success">{notice}</div>}
      <section className="form-panel ingest-source-panel"><div><span className="eyebrow">1 · Enroll source</span><h2>Folder, drive, USB, or SD card</h2><p>Enrollment inspects metadata and identity only. New sources begin read-only.</p></div><div className="form-grid"><label><span>Name</span><input value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="Camera card" /></label><label><span>Absolute path or mountpoint</span><input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/media/user/CAMERA" /></label><label><span>Source kind</span><select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as Root["kind"])}><option value="folder">Folder</option><option value="drive">Mounted drive</option><option value="sd-card">SD card</option><option value="drop-directory">Drop directory</option></select></label><button className="button button--soft" disabled={busy || !sourceName.trim() || !sourcePath.trim()} onClick={() => void proposeSource()}>Inspect source</button></div></section>
      <section className="ingest-builder"><div><span className="eyebrow">2 · Analyze source</span><h2>Build a copy proposal</h2><p>Nested folders are preserved by default so projects and albums stay coherent. Loose files receive category-aware destinations.</p></div><div className="ingest-form"><label><span>Source</span><select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">Choose source</option>{sources.map((source) => <option value={source.id} key={source.id}>{source.displayName}</option>)}</select></label><label><span>Destination library</span><select value={destinationId} onChange={(event) => setDestinationId(event.target.value)}><option value="">Choose library</option>{libraries.map((library) => <option value={library.root.id} key={library.root.id}>{library.root.displayName}</option>)}</select></label><label><span>Destination folder</span><input value={targetDirectory} onChange={(event) => setTargetDirectory(event.target.value)} /></label><label className="checkbox-control"><input type="checkbox" checked={preserveFolders} onChange={(event) => setPreserveFolders(event.target.checked)} /><span>Preserve source folders</span></label><label className="checkbox-control"><input type="checkbox" checked={retireSource} disabled={!selectedSource?.policy.allowSourceRetirement} onChange={(event) => setRetireSource(event.target.checked)} /><span>Retire verified sources to quarantine</span></label><div className="card-actions">{selectedSource && !selectedSource.policy.allowSourceRetirement && <button className="button button--ghost" onClick={() => { setPending("retirement"); setConfirmation(""); }}>Enable source retirement…</button>}<button className="button button--primary" disabled={busy || !sourceId || !destinationId} onClick={() => void createPlan()}>Analyze source</button></div></div></section>
      <section><div className="section-heading"><div><h2>Ingest sessions</h2><p>Analysis and transfers are persistent local jobs.</p></div><span className="count-pill">{plans.length}</span></div><div className="plan-tabs transfer-tabs">{plans.map((plan) => <button key={plan.id} className={`plan-tab ${plan.id === selectedPlanId ? "plan-tab--active" : ""}`} onClick={() => setSelectedPlanId(plan.id)}><strong>{plan.counts.total.toLocaleString()} files</strong><span>{plan.status.replaceAll("-", " ")}</span><small>{formatDate(plan.createdAt)} · {formatBytes(plan.counts.totalBytes)}</small></button>)}</div></section>
      {selectedPlan && <section className="transfer-detail"><div className="plan-summary"><div><span className="eyebrow">Reviewable ingest plan</span><h2>{selectedPlan.targetDirectory}</h2><p>{selectedPlan.retireSource ? "Verified source retirement requested; sources go to quarantine." : "COPY is the operation; source files remain untouched."}</p></div><Metric label="Ready" value={selectedPlan.counts.ready} /><Metric label="Already present" value={selectedPlan.counts.exactDuplicates} /><Metric label="Needs Review" value={selectedPlan.counts.needsReview} /><Metric label="Failed" value={selectedPlan.counts.failed} /></div>
        <div className="table-shell"><table className="inventory-table"><thead><tr><th>Source</th><th>Understanding</th><th>Proposed destination</th><th>Identity</th><th>Status</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={item.status === "needs-review" || item.status === "failed" ? "row--attention" : ""}><td><strong>{item.originalFileName}</strong><span className="path-cell">{item.sourceRelativePath}</span></td><td>{item.category ?? "—"}<small className="table-subcopy">{item.confidence === undefined ? "" : `${Math.round(item.confidence * 100)}% confidence`}</small></td><td>{item.status === "needs-review" ? <input value={resolutionPaths[item.id] ?? ""} onChange={(event) => setResolutionPaths((current) => ({ ...current, [item.id]: event.target.value }))} /> : <code>{item.destinationRelativePath ?? (item.duplicateMatches.length > 0 ? "Already in library" : "—")}</code>}</td><td><code>{item.digestHex ? `${item.digestHex.slice(0, 12)}…` : "pending"}</code></td><td><StatusBadge status={item.status} />{item.error && <small className="table-error">{item.error.message}</small>}</td><td>{item.status === "needs-review" && <button className="button button--soft button--mini" disabled={busy} onClick={() => void resolveItem(item)}>Save</button>}</td></tr>)}</tbody></table></div>
        {itemNextCursor && <button className="button button--soft" onClick={() => void loadItems(itemNextCursor, true)}>Load more items</button>}
        <div className="execution-panel"><div><span className="eyebrow">3 · Approve</span><h2>Copy, verify, catalog, receipt</h2><p>Destination collisions refuse safely. If verification fails, the source remains. This approval is separate from global and library write gates.</p></div><button className="button button--primary" disabled={selectedPlan.status !== "ready-for-approval" || busy} onClick={() => { setPending("approval"); setConfirmation(""); }}>Review approval</button></div>
      </section>}
      <ConfirmationDialog open={pending === "enrollment"} title="Approve ingest source" confirmLabel="Approve read-only source" busy={busy} onCancel={() => { setPending(undefined); setProposal(undefined); }} onConfirm={() => void approveSource()}>{proposal && <div className="review-sheet"><dl><div><dt>Selected</dt><dd>{proposal.displayPath}</dd></div><div><dt>Canonical</dt><dd>{proposal.canonicalPath}</dd></div><div><dt>Device</dt><dd>{proposal.identity.volume.volumeGuid ?? proposal.identity.volume.deviceId}</dd></div></dl>{proposal.warnings.map((warning) => <p className="review-warning" key={warning}>{warning}</p>)}</div>}</ConfirmationDialog>
      <ConfirmationDialog open={pending === "retirement"} title="Enable recoverable source retirement" confirmLabel="Enable source retirement" danger busy={busy} confirmDisabled={confirmation !== "ENABLE SOURCE RETIREMENT"} onCancel={() => { setPending(undefined); setConfirmation(""); }} onConfirm={() => void enableRetirement()}><p>This permits Local Librarian to move a source copy into an app-managed quarantine, but only after a destination is copied and content-verified. Every plan still needs approval.</p><label><span>Type <code>ENABLE SOURCE RETIREMENT</code></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label></ConfirmationDialog>
      <ConfirmationDialog open={pending === "approval"} title="Approve verified ingest" confirmLabel="Queue ingest" danger={selectedPlan?.retireSource === true} busy={busy} confirmDisabled={confirmation !== approvalPhrase} onCancel={() => { setPending(undefined); setConfirmation(""); }} onConfirm={() => void approvePlan()}><p>{selectedPlan?.retireSource ? "Files are copied and verified before their source copies move into recoverable quarantine." : "Files are copied and verified. Every source copy remains in place."}</p><label><span>Type <code>{approvalPhrase}</code></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label></ConfirmationDialog>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return <div className="metric"><strong>{value.toLocaleString()}</strong><span>{label}</span></div>;
}
