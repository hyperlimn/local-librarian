import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate, shortId } from "../format";
import type {
  LibraryView,
  OrganizationOperation,
  OrganizationPlan,
  OrganizationRun,
  OrganizationRunItem,
  SystemState,
} from "../types";

type PendingConfirmation =
  | { readonly kind: "apply"; readonly plan: OrganizationPlan }
  | { readonly kind: "rollback"; readonly run: OrganizationRun }
  | undefined;

export function OrganizePage() {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [rootId, setRootId] = useState("");
  const [plans, setPlans] = useState<OrganizationPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [operations, setOperations] = useState<OrganizationOperation[]>([]);
  const [operationCursor, setOperationCursor] = useState<string>();
  const [operationNextCursor, setOperationNextCursor] = useState<string>();
  const [operationHistory, setOperationHistory] = useState<string[]>([]);
  const [runs, setRuns] = useState<OrganizationRun[]>([]);
  const [system, setSystem] = useState<SystemState>();
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runItems, setRunItems] = useState<OrganizationRunItem[]>([]);
  const [runItemCursor, setRunItemCursor] = useState<string>();
  const [runItemNextCursor, setRunItemNextCursor] = useState<string>();
  const [runItemHistory, setRunItemHistory] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<OrganizationPlan["options"]["strategy"]>("category-and-year");
  const [scope, setScope] = useState<OrganizationPlan["options"]["scope"]>("top-level");
  const [targetDirectory, setTargetDirectory] = useState("Organized");
  const [collisionPolicy, setCollisionPolicy] = useState<OrganizationPlan["options"]["collisionPolicy"]>("rename-with-suffix");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [maximumOperations, setMaximumOperations] = useState(10_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmation, setConfirmation] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();

  const selectedLibrary = useMemo(
    () => libraries.find((library) => library.root.id === rootId),
    [libraries, rootId],
  );
  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === selectedPlanId),
    [plans, selectedPlanId],
  );

  const selectedReceiptRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId),
    [runs, selectedRunId],
  );
  const loadFoundations = useCallback(async () => {
    try {
      const [libraryPage, state] = await Promise.all([
        api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=true"),
        api<SystemState>("/api/system"),
      ]);
      setLibraries(libraryPage.items);
      setRootId((current) => current || libraryPage.items.find(
        (library) => library.root.approval.status === "approved",
      )?.root.id || libraryPage.items[0]?.root.id || "");
      setSystem(state);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Organization state could not be loaded.");
    }
  }, []);

  const loadPlans = useCallback(async () => {
    if (!rootId) {
      setPlans([]);
      setSelectedPlanId("");
      return;
    }
    const page = await api<{ items: OrganizationPlan[] }>(
      `/api/organization/plans?rootId=${encodeURIComponent(rootId)}&limit=100`,
    );
    setPlans(page.items);
    setSelectedPlanId((current) =>
      page.items.some((plan) => plan.id === current) ? current : page.items[0]?.id || "",
    );
  }, [rootId]);

  const loadPlanDetail = useCallback(async () => {
    if (!selectedPlanId) {
      setOperations([]);
      setOperationNextCursor(undefined);
      setRuns([]);
      return;
    }
    const [operationPage, runPage, state] = await Promise.all([
      api<{ items: OrganizationOperation[]; nextCursor?: string }>(
        `/api/organization/plans/${encodeURIComponent(selectedPlanId)}/operations?limit=200${operationCursor === undefined ? "" : `&cursor=${encodeURIComponent(operationCursor)}`}`,
      ),
      api<{ items: OrganizationRun[] }>(
        `/api/organization/runs?planId=${encodeURIComponent(selectedPlanId)}&limit=100`,
      ),
      api<SystemState>("/api/system"),
    ]);
    setOperations(operationPage.items);
    setOperationNextCursor(operationPage.nextCursor);
    setRuns(runPage.items);
    setSystem(state);
  }, [operationCursor, selectedPlanId]);

  const loadRunItems = useCallback(async () => {
    if (!selectedRunId) {
      setRunItems([]);
      setRunItemNextCursor(undefined);
      return;
    }
    const page = await api<{ items: OrganizationRunItem[]; nextCursor?: string }>(
      `/api/organization/runs/${encodeURIComponent(selectedRunId)}/items?limit=200${runItemCursor === undefined ? "" : `&cursor=${encodeURIComponent(runItemCursor)}`}`,
    );
    setRunItems(page.items);
    setRunItemNextCursor(page.nextCursor);
  }, [runItemCursor, selectedRunId]);

  useEffect(() => { void loadFoundations(); }, [loadFoundations]);
  useEffect(() => {
    void loadPlans().catch((value: unknown) =>
      setError(value instanceof Error ? value.message : "Plans could not be loaded."));
  }, [loadPlans]);
  useEffect(() => {
    setOperationCursor(undefined);
    setOperationHistory([]);
    setSelectedRunId("");
    setRunItems([]);
    setRunItemCursor(undefined);
    setRunItemHistory([]);
  }, [selectedPlanId]);
  useEffect(() => {
    void loadPlanDetail().catch((value: unknown) =>
      setError(value instanceof Error ? value.message : "Plan detail could not be loaded."));
    const timer = window.setInterval(() => {
      void loadPlanDetail().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [loadPlanDetail]);
  useEffect(() => {
    void loadRunItems().catch((value: unknown) =>
      setError(value instanceof Error ? value.message : "Run receipts could not be loaded."));
    const timer = window.setInterval(
      () => void loadRunItems().catch(() => undefined),
      3_000,
    );
    return () => window.clearInterval(timer);
  }, [loadRunItems]);

  async function createPlan() {
    if (!rootId) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const plan = await post<OrganizationPlan>("/api/organization/plans", {
        rootId,
        strategy,
        scope,
        targetDirectory,
        collisionPolicy,
        includeHidden,
        maximumOperations,
        createdBy: "local-web-user",
      });
      await loadPlans();
      setSelectedPlanId(plan.id);
      setNotice(`Plan ready: ${plan.counts.plannedMoves.toLocaleString()} safe file moves to review.`);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "The organization plan could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function submitPlan(mode: "simulation" | "live", phrase: string) {
    if (!selectedPlan) return;
    setBusy(true);
    try {
      const run = await post<OrganizationRun>(
        `/api/organization/plans/${encodeURIComponent(selectedPlan.id)}/runs`,
        { mode, approvedBy: "local-web-user", confirmation: phrase },
      );
      await startWorkerQuietly();
      await loadPlanDetail();
      setPendingConfirmation(undefined);
      setConfirmation("");
      setNotice(
        mode === "simulation"
          ? `Read-only test queued as ${shortId(run.id)}.`
          : `Live organization queued as ${shortId(run.id)}.`,
      );
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "The plan could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  async function submitRollback(run: OrganizationRun, mode: "simulation" | "live", phrase: string) {
    setBusy(true);
    try {
      const rollback = await post<OrganizationRun>(
        `/api/organization/runs/${encodeURIComponent(run.id)}/rollback`,
        { mode, approvedBy: "local-web-user", confirmation: phrase },
      );
      await startWorkerQuietly();
      await loadPlanDetail();
      setPendingConfirmation(undefined);
      setConfirmation("");
      setNotice(`${mode === "live" ? "Rollback" : "Rollback test"} queued as ${shortId(rollback.id)}.`);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Rollback could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  function nextOperationPage() {
    if (operationNextCursor === undefined) return;
    setOperationHistory((current) => [...current, operationCursor ?? ""]);
    setOperationCursor(operationNextCursor);
  }

  function previousOperationPage() {
    const previous = operationHistory[operationHistory.length - 1];
    if (previous === undefined) return;
    setOperationHistory((current) => current.slice(0, -1));
    setOperationCursor(previous.length === 0 ? undefined : previous);
  }

  function toggleRunReceipts(runId: string) {
    setSelectedRunId((current) => current === runId ? "" : runId);
    setRunItemCursor(undefined);
    setRunItemHistory([]);
  }

  function nextRunItemPage() {
    if (runItemNextCursor === undefined) return;
    setRunItemHistory((current) => [...current, runItemCursor ?? ""]);
    setRunItemCursor(runItemNextCursor);
  }

  function previousRunItemPage() {
    const previous = runItemHistory[runItemHistory.length - 1];
    if (previous === undefined) return;
    setRunItemHistory((current) => current.slice(0, -1));
    setRunItemCursor(previous.length === 0 ? undefined : previous);
  }

  const scan = selectedLibrary?.summary.latestScan;
  const canPlan = selectedLibrary?.root.approval.status === "approved" && scan?.status === "completed";
  const liveReady = system?.mutationMode.mode === "live" &&
    selectedLibrary?.root.policy.allowWrites === true;
  const activeRun = runs.find((run) =>
    run.status === "queued" || run.status === "running" || run.status === "paused");
  const applyPhrase = selectedPlan === undefined
    ? ""
    : `APPLY ${selectedPlan.counts.plannedMoves} FILE MOVES`;
  const rollbackRun = pendingConfirmation?.kind === "rollback"
    ? pendingConfirmation.run
    : undefined;
  const rollbackPhrase = rollbackRun === undefined
    ? ""
    : `ROLL BACK ${rollbackRun.counts.succeeded} FILE MOVES`;

  return (
    <div className="page-stack">
      <header className="page-header page-header--split">
        <div>
          <span className="eyebrow">Plan · test · apply · undo</span>
          <h1>Organize</h1>
          <p>Turn a completed inventory into small, explainable moves. Test every precondition read-only, apply only with both safety interlocks, and roll successful moves back.</p>
        </div>
        <label className="select-control"><span>Library</span><select value={rootId} onChange={(event) => setRootId(event.target.value)}>{libraries.map((library) => <option value={library.root.id} key={library.root.id}>{library.root.displayName}</option>)}</select></label>
      </header>
      {error && <div className="notice notice--error">{error}</div>}
      {notice && <div className="notice notice--success">{notice}</div>}

      <section className={`mode-banner mode-banner--${system?.mutationMode.mode ?? "read-only"}`}>
        <div><span className="eyebrow">Execution mode</span><h2>{system?.mutationMode.mode === "live" ? "Live file mutation enabled" : "Read-only testing"}</h2><p>{system?.mutationMode.mode === "live" ? "Only separately write-approved libraries can be changed. Every move is revalidated and journaled." : "Plans and full precondition simulations work; no files or folders will be changed."}</p></div>
        <div><StatusBadge status={system?.mutationMode.mode === "live" ? "live" : "read-only"} /><a className="button button--soft" href="#safety">Change safety mode</a></div>
      </section>

      <section className="organize-builder">
        <div>
          <span className="eyebrow">1 · Choose a policy</span>
          <h2>Create a fresh plan</h2>
          <p>Top-level scope preserves folders that may already carry meaning. “All files” intentionally flattens files into the new structure.</p>
          {!canPlan && <p className="inline-error">A completed inventory scan of an approved library is required. <a href="#inventory">Open inventory →</a></p>}
        </div>
        <div className="organize-form">
          <label><span>Structure</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)}><option value="category-and-year">Category, then year</option><option value="category">Category only</option><option value="year-and-month">Year, then month</option></select></label>
          <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="top-level">Loose top-level files</option><option value="all-files">All files</option></select></label>
          <label><span>Destination folder</span><input value={targetDirectory} onChange={(event) => setTargetDirectory(event.target.value)} /></label>
          <label><span>Name collisions</span><select value={collisionPolicy} onChange={(event) => setCollisionPolicy(event.target.value as typeof collisionPolicy)}><option value="rename-with-suffix">Keep both with suffix</option><option value="skip">Skip collisions</option></select></label>
          <label><span>Maximum moves</span><input type="number" min={1} max={50_000} value={maximumOperations} onChange={(event) => setMaximumOperations(Number(event.target.value))} /></label>
          <label className="checkbox-control"><input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} /><span>Include hidden files</span></label>
          <button className="button button--primary" disabled={!canPlan || busy} onClick={() => void createPlan()}>{busy ? "Working…" : "Build review plan"}</button>
        </div>
      </section>

      <section>
        <div className="section-heading"><div><span className="eyebrow">2 · Review</span><h2>Saved plans</h2></div><span className="count-pill">{plans.length}</span></div>
        {plans.length > 0 ? <div className="plan-tabs">{plans.map((plan) => <button className={plan.id === selectedPlanId ? "plan-tab plan-tab--active" : "plan-tab"} onClick={() => setSelectedPlanId(plan.id)} key={plan.id}><strong>{plan.counts.plannedMoves.toLocaleString()} moves</strong><span>{plan.options.strategy.replaceAll("-", " ")}</span><small>{formatDate(plan.createdAt)}</small></button>)}</div> : <div className="quiet-card">No plan has been created for this library.</div>}
      </section>

      {selectedPlan && <>
        <section className="plan-summary">
          <div><span className="eyebrow">Plan snapshot</span><h2>{shortId(selectedPlan.id)}</h2><p>Based on immutable scan <code>{shortId(selectedPlan.scanId)}</code>.</p></div>
          <PlanMetric value={selectedPlan.counts.plannedMoves.toLocaleString()} label="Moves" />
          <PlanMetric value={formatBytes(selectedPlan.counts.representedBytes)} label="Represented" />
          <PlanMetric value={selectedPlan.counts.preservedByScope.toLocaleString()} label="Folders preserved" />
          <PlanMetric value={selectedPlan.counts.hiddenExcluded.toLocaleString()} label="Hidden excluded" />
        </section>
        <section>
          <div className="section-heading"><div><h2>Move preview</h2><p>Every destination is root-relative; no existing destination will be overwritten.</p></div><span className="count-pill">{selectedPlan.counts.plannedMoves.toLocaleString()}</span></div>
          <div className="table-shell"><table className="inventory-table move-table"><thead><tr><th>#</th><th>From</th><th>To</th><th>Why</th><th className="numeric">Size</th></tr></thead><tbody>{operations.map((operation) => <tr key={operation.id}><td>{operation.ordinal + 1}</td><td><code>{operation.sourceRelativePath}</code></td><td><code>{operation.destinationRelativePath}</code></td><td>{operation.rationale}</td><td className="numeric">{formatBytes(operation.expected.byteLength)}</td></tr>)}{operations.length === 0 && <tr><td colSpan={5} className="empty-table">This scan is already organized under the selected policy.</td></tr>}</tbody></table></div>
          {selectedPlan.counts.plannedMoves > 0 && <div className="pagination"><button className="button button--ghost button--mini" disabled={operationHistory.length === 0} onClick={previousOperationPage}>Previous</button><span>Page {operationHistory.length + 1} · {operations[0]?.ordinal === undefined ? 0 : operations[0].ordinal + 1}–{operations.at(-1)?.ordinal === undefined ? 0 : operations.at(-1)!.ordinal + 1} of {selectedPlan.counts.plannedMoves.toLocaleString()}</span><button className="button button--ghost button--mini" disabled={operationNextCursor === undefined} onClick={nextOperationPage}>Next</button></div>}
        </section>
        <section className="execution-panel">
          <div><span className="eyebrow">3 · Verify and execute</span><h2>Run this plan</h2><p>Testing performs current root, source, destination, collision, identity, and metadata checks without creating a directory or moving a file.</p></div>
          <div className="card-actions"><button className="button button--soft" disabled={busy || activeRun !== undefined || selectedPlan.counts.plannedMoves === 0} onClick={() => void submitPlan("simulation", "SIMULATE")}>Test safely</button><button className="button button--primary" disabled={busy || activeRun !== undefined || selectedPlan.counts.plannedMoves === 0 || !liveReady} onClick={() => { setConfirmation(""); setPendingConfirmation({ kind: "apply", plan: selectedPlan }); }}>Apply plan</button></div>
          {!liveReady && <small>Live apply requires global live mode and write approval for this library.</small>}
        </section>
        <section>
          <div className="section-heading"><div><h2>Run history</h2><p>Each run has its own durable job and per-file receipt.</p></div><span className="count-pill">{runs.length}</span></div>
          <div className="run-list">{runs.map((run) => <article className="run-card" key={run.id}><div><span className="eyebrow">{run.mode.replaceAll("-", " ")}</span><strong>{shortId(run.id)}</strong><small>{formatDate(run.completedAt ?? run.createdAt)}</small></div><div className="run-counts"><span>{run.counts.succeeded} succeeded</span><span>{run.counts.skipped} skipped</span><span>{run.counts.failed} failed</span></div><StatusBadge status={run.status} /><div className="card-actions"><button className="button button--ghost button--mini" onClick={() => toggleRunReceipts(run.id)}>{selectedRunId === run.id ? "Hide receipts" : "View receipts"}</button>{run.mode === "live" && (run.status === "completed" || run.status === "partial") && run.counts.succeeded > 0 && <><button className="button button--ghost button--mini" disabled={activeRun !== undefined} onClick={() => void submitRollback(run, "simulation", "SIMULATE ROLLBACK")}>Test rollback</button><button className="button button--soft button--mini" disabled={activeRun !== undefined || !liveReady} onClick={() => { setConfirmation(""); setPendingConfirmation({ kind: "rollback", run }); }}>Roll back</button></>}</div></article>)}{runs.length === 0 && <div className="quiet-card">No tests or live runs for this plan.</div>}</div>
        </section>
        {selectedReceiptRun && <section className="receipt-panel">
          <div className="section-heading"><div><span className="eyebrow">Per-file evidence</span><h2>{selectedReceiptRun.mode.replaceAll("-", " ")} receipts</h2><p>Recorded outcomes and explanations for run <code>{shortId(selectedReceiptRun.id)}</code>.</p></div><StatusBadge status={selectedReceiptRun.status} /></div>
          <div className="table-shell"><table className="inventory-table receipt-table"><thead><tr><th>#</th><th>From</th><th>To</th><th>Outcome</th><th>Message</th></tr></thead><tbody>{runItems.map((item) => <tr key={item.operationId}><td>{item.operation.ordinal + 1}</td><td><code>{item.operation.sourceRelativePath}</code></td><td><code>{item.operation.destinationRelativePath}</code></td><td><StatusBadge status={item.outcome} /></td><td className="receipt-message">{item.message}</td></tr>)}{runItems.length === 0 && <tr><td colSpan={5} className="empty-table">No per-file receipts have been recorded yet.</td></tr>}</tbody></table></div>
          {selectedReceiptRun.counts.processed > 0 && <div className="pagination"><button className="button button--ghost button--mini" disabled={runItemHistory.length === 0} onClick={previousRunItemPage}>Previous</button><span>Page {runItemHistory.length + 1} · {runItems.length.toLocaleString()} shown of {selectedReceiptRun.counts.processed.toLocaleString()} processed</span><button className="button button--ghost button--mini" disabled={runItemNextCursor === undefined} onClick={nextRunItemPage}>Next</button></div>}
        </section>}
      </>}

      <ConfirmationDialog open={pendingConfirmation?.kind === "apply"} title="Apply reviewed file moves?" confirmLabel="Apply live plan" danger busy={busy} confirmDisabled={confirmation !== applyPhrase} onCancel={() => setPendingConfirmation(undefined)} onConfirm={() => void submitPlan("live", confirmation)}>
        <p>This will create destination folders and atomically relocate <strong>{selectedPlan?.counts.plannedMoves.toLocaleString()}</strong> files. Existing files are never overwritten.</p><label><span>Type <code>{applyPhrase}</code></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
      </ConfirmationDialog>
      <ConfirmationDialog open={pendingConfirmation?.kind === "rollback"} title="Restore moved files?" confirmLabel="Run live rollback" danger busy={busy} confirmDisabled={confirmation !== rollbackPhrase} onCancel={() => setPendingConfirmation(undefined)} onConfirm={() => rollbackRun && void submitRollback(rollbackRun, "live", confirmation)}>
        <p>Rollback revalidates each organized file and restores it only when the original path is free. Destination folders are left in place.</p><label><span>Type <code>{rollbackPhrase}</code></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
      </ConfirmationDialog>
    </div>
  );
}

function PlanMetric({ value, label }: { readonly value: string; readonly label: string }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

async function startWorkerQuietly(): Promise<void> {
  try { await post("/api/worker/start"); } catch { /* A running worker needs no action. */ }
}
