import { useCallback, useEffect, useState } from "react";

import { api, post } from "../api";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { LibraryCard } from "../components/LibraryCard";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes } from "../format";
import type { DiscoveredVolume, LibraryView, Proposal } from "../types";

export function LibrariesPage({ navigate }: { readonly navigate: (page: string) => void }) {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [volumes, setVolumes] = useState<DiscoveredVolume[]>([]);
  const [path, setPath] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [proposal, setProposal] = useState<Proposal>();
  const [revokeTarget, setRevokeTarget] = useState<LibraryView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [libraryResult, volumeResult] = await Promise.all([
        api<{ items: LibraryView[] }>("/api/libraries?includeRevoked=true"),
        api<{ items: DiscoveredVolume[] }>("/api/drives"),
      ]);
      setLibraries(libraryResult.items);
      setVolumes(volumeResult.items);
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to load libraries.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function propose() {
    setBusy(true);
    try {
      setProposal(await post<Proposal>("/api/enrollment/proposals", { path, displayName }));
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Enrollment inspection failed.");
    } finally { setBusy(false); }
  }

  async function approve() {
    if (!proposal) return;
    setBusy(true);
    try {
      await post(`/api/enrollment/proposals/${encodeURIComponent(proposal.proposalId)}/approve`, { approvedBy: "local-web-user" });
      setProposal(undefined); setPath(""); setDisplayName(""); await load();
    } catch (value) { setError(value instanceof Error ? value.message : "Approval failed."); }
    finally { setBusy(false); }
  }

  async function revoke() {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      await post(`/api/libraries/${encodeURIComponent(revokeTarget.root.id)}/revoke`, { reason: "Revoked from Local Librarian WebUI" });
      setRevokeTarget(undefined); await load();
    } catch (value) { setError(value instanceof Error ? value.message : "Revocation failed."); }
    finally { setBusy(false); }
  }

  function chooseVolume(volume: DiscoveredVolume) {
    setPath(volume.mountPath);
    setDisplayName(volume.label || `${volume.driveLetter ?? volume.mountPath} Library`);
    document.getElementById("enrollment-form")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <div className="page-stack">
      <header className="page-header"><div><span className="eyebrow">Approved boundaries</span><h1>Libraries</h1><p>Discover a volume or choose a folder. Inspection always comes before explicit approval.</p></div></header>
      {error && <div className="notice notice--error">{error}</div>}

      <section>
        <div className="section-heading"><div><h2>Mounted volumes</h2><p>Operating-system volume information only. Nothing is scanned.</p></div><button className="button button--soft" onClick={() => void load()}>Refresh</button></div>
        <div className="volume-grid">
          {volumes.map((volume) => (
            <article className="volume-card" key={volume.mountPath}>
              <div className="volume-card__drive">{volume.driveLetter ?? volume.mountPath}</div>
              <div className="volume-card__body"><h3>{volume.label || "Unnamed volume"}</h3><p>{volume.filesystem ?? "Unknown filesystem"} · {volume.classification}</p><div className="capacity"><span style={{ width: volume.totalBytes && volume.freeBytes !== undefined ? `${Math.max(2, (1 - volume.freeBytes / volume.totalBytes) * 100)}%` : "0%" }} /></div><small>{formatBytes(volume.freeBytes)} free of {formatBytes(volume.totalBytes)}</small></div>
              <div><StatusBadge status={volume.approvalStatus ?? volume.enrollmentStatus} />{volume.enrollmentStatus === "not-enrolled" && <button className="button button--mini" onClick={() => chooseVolume(volume)}>Select</button>}</div>
            </article>
          ))}
          {volumes.length === 0 && <div className="quiet-card">No Windows logical volumes were reported. You can still choose a folder manually.</div>}
        </div>
      </section>

      <section id="enrollment-form" className="form-panel">
        <div><span className="eyebrow">New library</span><h2>Inspect a drive or folder</h2><p>This creates an unapproved proposal only. Review the canonical and volume identity before approval.</p></div>
        <div className="form-grid"><label><span>Folder or drive path</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\Photos" /></label><label><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Photo archive" /></label><button className="button button--primary" onClick={() => void propose()} disabled={busy || !path || !displayName}>{busy ? "Inspecting…" : "Propose enrollment"}</button></div>
      </section>

      <section><div className="section-heading"><h2>Enrolled roots</h2><span className="count-pill">{libraries.length}</span></div><div className="card-grid card-grid--libraries">{libraries.map((library) => <LibraryCard key={library.root.id} library={library} onScan={library.root.approval.status === "approved" ? () => void post(`/api/libraries/${encodeURIComponent(library.root.id)}/scans`).then(() => navigate("inventory")) : undefined} onBrowse={() => navigate("inventory")} onRevoke={() => setRevokeTarget(library)} />)}</div></section>

      <ConfirmationDialog open={proposal !== undefined} title="Review enrollment" confirmLabel="Approve library" busy={busy} onCancel={() => setProposal(undefined)} onConfirm={() => void approve()}>
        {proposal && <div className="review-sheet"><dl><div><dt>Selected path</dt><dd>{proposal.displayPath}</dd></div><div><dt>Canonical path</dt><dd>{proposal.canonicalPath}</dd></div><div><dt>Volume stability</dt><dd>{proposal.identity.volume.stability}</dd></div><div><dt>Device identity</dt><dd>{proposal.identity.volume.volumeGuid ?? proposal.identity.volume.deviceId}</dd></div></dl>{proposal.warnings.map((warning) => <p className="review-warning" key={warning}>{warning}</p>)}<strong className="explicit-copy">This root is not approved until you confirm.</strong></div>}
      </ConfirmationDialog>
      <ConfirmationDialog open={revokeTarget !== undefined} title="Revoke library approval?" confirmLabel="Revoke approval" danger busy={busy} onCancel={() => setRevokeTarget(undefined)} onConfirm={() => void revoke()}><p>Scanning will no longer be permitted for <strong>{revokeTarget?.root.displayName}</strong>. Existing inventory observations remain available.</p></ConfirmationDialog>
    </div>
  );
}
