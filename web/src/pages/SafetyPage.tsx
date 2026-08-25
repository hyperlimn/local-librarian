import { useCallback, useEffect, useState } from "react";

import { api, post } from "../api";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { SafetyIndicator } from "../components/SafetyIndicator";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate, shortId } from "../format";
import type {
  AuditIntegrity,
  LibraryView,
  OrganizationAuditEvent,
  SystemState,
  WorkerStatus,
} from "../types";

interface SafetyData {
  readonly system: SystemState;
  readonly libraries: LibraryView[];
  readonly worker: WorkerStatus;
  readonly auditIntegrity: AuditIntegrity;
}

type ConfirmationTarget =
  | { readonly kind: "mode"; readonly mode: "read-only" | "live" }
  | { readonly kind: "root"; readonly library: LibraryView; readonly allowWrites: boolean }
  | undefined;

export function SafetyPage() {
  const [data, setData] = useState<SafetyData>();
  const [audit, setAudit] = useState<OrganizationAuditEvent[]>([]);
  const [target, setTarget] = useState<ConfirmationTarget>();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [safety, events] = await Promise.all([
        api<SafetyData>("/api/safety"),
        api<{ items: OrganizationAuditEvent[] }>("/api/organization/audit?limit=30"),
      ]);
      setData(safety);
      setAudit(events.items);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Safety state could not be loaded.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function startWorker() {
    try {
      await post("/api/worker/start");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Worker could not be started.");
    }
  }

  async function confirmChange() {
    if (!target) return;
    setBusy(true);
    try {
      if (target.kind === "mode") {
        await post("/api/safety/mutation-mode", {
          mode: target.mode,
          updatedBy: "local-web-user",
          confirmation,
        });
        setNotice(
          target.mode === "live"
            ? "Live mutation capability is enabled. Each library still requires separate write approval."
            : "Read-only testing is active. Queued live work will stop before another move.",
        );
      } else {
        await post(`/api/libraries/${encodeURIComponent(target.library.root.id)}/write-access`, {
          allowWrites: target.allowWrites,
          approvedBy: "local-web-user",
          confirmation,
        });
        setNotice(
          `${target.library.root.displayName} write access ${target.allowWrites ? "approved" : "disabled"}.`,
        );
      }
      setTarget(undefined);
      setConfirmation("");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "The safety setting could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <div className="page-state"><div className="spinner" /><h1>Checking safety state</h1><p>{error ?? "Reading Local Librarian application state…"}</p></div>;
  }
  const approved = data.libraries.filter((library) => library.root.approval.status === "approved");
  const revoked = data.libraries.filter((library) => library.root.approval.status === "revoked");
  const expectedConfirmation = target?.kind === "mode"
    ? target.mode === "live" ? "ENABLE LIVE FILE MUTATION" : "DISABLE"
    : target?.kind === "root"
      ? target.allowWrites ? "ENABLE LIBRARY WRITES" : "DISABLE LIBRARY WRITES"
      : "";

  return (
    <div className="page-stack">
      <header className="page-header"><div><span className="eyebrow">Boundaries, interlocks, and receipts</span><h1>Safety</h1><p>Global capability and per-library approval are independent. Turn mutation off at any time; queued or running live work rechecks the switch before every file move.</p></div></header>
      {error && <div className="notice notice--error">{error}</div>}
      {notice && <div className="notice notice--success">{notice}</div>}
      <SafetyIndicator mode={data.system.mutationMode.mode} />

      <section className="safety-control-panel">
        <div><span className="eyebrow">Interlock 1 of 2</span><h2>Global mutation capability</h2><p>Read-only is the fail-closed default. Simulation remains fully available in either mode.</p></div>
        <div className="safety-control-panel__state"><StatusBadge status={data.system.mutationMode.mode === "live" ? "live" : "read-only"} /><small>Changed {formatDate(data.system.mutationMode.updatedAt)} by {data.system.mutationMode.updatedBy}</small><button className={data.system.mutationMode.mode === "live" ? "button button--danger" : "button button--primary"} onClick={() => { setConfirmation(""); setTarget({ kind: "mode", mode: data.system.mutationMode.mode === "live" ? "read-only" : "live" }); }}>{data.system.mutationMode.mode === "live" ? "Return to read-only" : "Enable live mutation"}</button></div>
      </section>

      <section className="diagnostic-grid">
        <article className="diagnostic-card"><span className="eyebrow">Worker</span><div className="diagnostic-card__title"><h2>{data.worker.status}</h2><StatusBadge status={data.worker.status} /></div><dl><div><dt>Worker ID</dt><dd>{data.worker.workerId ? shortId(data.worker.workerId) : "-"}</dd></div><div><dt>PID</dt><dd>{data.worker.pid ?? "-"}</dd></div><div><dt>Heartbeat</dt><dd>{formatDate(data.worker.heartbeatAt)}</dd></div></dl>{(data.worker.status === "offline" || data.worker.status === "stale") && <button className="button button--primary" onClick={() => void startWorker()}>Start local worker</button>}</article>
        <article className="diagnostic-card"><span className="eyebrow">Runtime</span><h2>Local Librarian {data.system.version}</h2><dl><div><dt>Network binding</dt><dd>{data.system.binding}</dd></div><div><dt>Safety boundaries</dt><dd>{data.system.safetyStatus}</dd></div><div><dt>Execution</dt><dd>{data.system.filesystemExecution}</dd></div><div><dt>Rollback</dt><dd>{data.system.capabilities.rollback ? "available" : "unavailable"}</dd></div></dl></article>
      </section>

      <section>
        <div className="section-heading"><div><span className="eyebrow">Interlock 2 of 2</span><h2>Approved library roots</h2><p>A global live switch never grants a library write access by itself.</p></div><span className="count-pill">{approved.length}</span></div>
        <div className="root-list">{approved.map((library) => <article className="root-row root-row--write" key={library.root.id}><div><strong>{library.root.displayName}</strong><code>{library.root.displayPath}</code></div><div><small>{library.root.policy.allowWrites ? "Writes explicitly approved" : "Inventory and simulation only"}</small><StatusBadge status={library.root.policy.allowWrites ? "write-approved" : "read-only"} /><button className={library.root.policy.allowWrites ? "button button--danger-text button--mini" : "button button--soft button--mini"} onClick={() => { setConfirmation(""); setTarget({ kind: "root", library, allowWrites: !library.root.policy.allowWrites }); }}>{library.root.policy.allowWrites ? "Disable writes" : "Approve writes"}</button></div></article>)}{approved.length === 0 && <div className="quiet-card">No roots are currently approved.</div>}</div>
      </section>

      <section className="audit-panel">
        <div className="section-heading"><div><span className="eyebrow">Tamper-evident history</span><h2>Organization audit</h2><p>Mode changes, plans, runs, moves, failures, and rollbacks form an append-only SHA-256 hash chain.</p></div><div className="audit-integrity"><StatusBadge status={data.auditIntegrity.valid ? "verified" : "failed"} /><span>{data.auditIntegrity.entriesChecked.toLocaleString()} entries checked</span></div></div>
        <div className="audit-list">{audit.map((event) => <article key={event.id}><span className="audit-sequence">#{event.sequence}</span><div><strong>{event.event.replaceAll(".", " · ")}</strong><small>{event.actor} · {formatDate(event.occurredAt)}</small></div><code title={event.entryHash}>{event.entryHash.slice(0, 12)}</code></article>)}{audit.length === 0 && <div className="quiet-card">The audit begins when a mode changes or an organization plan is created.</div>}</div>
      </section>

      {revoked.length > 0 && <section><div className="section-heading"><h2>Revoked roots</h2><span className="count-pill">{revoked.length}</span></div><div className="root-list">{revoked.map((library) => <article className="root-row" key={library.root.id}><div><strong>{library.root.displayName}</strong><code>{library.root.displayPath}</code></div><StatusBadge status="revoked" /></article>)}</div></section>}
      <section className="paths-panel"><div><span className="eyebrow">Application-owned persistence</span><h2>State paths</h2><p>These fixed stores contain inventory, jobs, plans, receipts, and safety state. They are not generic filesystem endpoints.</p></div><dl>{Object.entries(data.system.databasePaths).map(([name, storedPath]) => <div key={name}><dt>{name}</dt><dd><code>{storedPath}</code></dd></div>)}</dl></section>

      <ConfirmationDialog open={target !== undefined} title={target?.kind === "mode" ? target.mode === "live" ? "Enable live file mutation?" : "Return to read-only testing?" : target?.allowWrites ? `Approve writes for ${target.library.root.displayName}?` : `Disable writes for ${target?.library.root.displayName}?`} confirmLabel="Confirm safety change" danger={target?.kind === "mode" ? target.mode === "live" : target?.allowWrites === true} busy={busy} confirmDisabled={confirmation !== expectedConfirmation} onCancel={() => setTarget(undefined)} onConfirm={() => void confirmChange()}>
        <p>{target?.kind === "mode" && target.mode === "live" ? "Live mode makes reviewed relocation and rollback jobs eligible to mutate separately approved roots. It does not enable permanent deletion." : target?.kind === "root" && target.allowWrites ? "This root can be changed only while global live mode is also enabled. Every operation still requires a reviewed plan and fresh safety checks." : "Disabling takes effect at the next per-file safety boundary."}</p><label><span>Type <code>{expectedConfirmation}</code></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
      </ConfirmationDialog>
    </div>
  );
}
