import { useCallback, useEffect, useMemo, useState } from "react";

import { api, post } from "../api";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDate } from "../format";
import type { DuplicateGroup, DuplicateMember, TransferPlan } from "../types";

export function DuplicatesPage({ navigate }: { readonly navigate: (page: string) => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [members, setMembers] = useState<DuplicateMember[]>([]);
  const [keepers, setKeepers] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState("reclaimable-desc");
  const [nextCursor, setNextCursor] = useState<string>();
  const [memberNextCursor, setMemberNextCursor] = useState<string>();
  const [proposal, setProposal] = useState<TransferPlan>();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const selected = useMemo(() => groups.find((group) => group.id === selectedId), [groups, selectedId]);

  const loadGroups = useCallback(async (cursor?: string, append = false) => {
    const query = new URLSearchParams({ limit: "50", sort });
    if (cursor) query.set("cursor", cursor);
    if (search.trim()) query.set("search", search.trim());
    if (kind) query.set("kind", kind);
    const page = await api<{ items: DuplicateGroup[]; nextCursor?: string }>(`/api/duplicates?${query}`);
    setGroups((current) => append ? [...current, ...page.items] : page.items);
    setNextCursor(page.nextCursor);
    if (!append) setSelectedId((current) => page.items.some((group) => group.id === current) ? current : page.items[0]?.id || "");
  }, [kind, search, sort]);

  const loadMembers = useCallback(async (cursor?: string, append = false) => {
    if (!selectedId) { setMembers([]); return; }
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const page = await api<{ items: DuplicateMember[]; nextCursor?: string }>(
      `/api/duplicates/${encodeURIComponent(selectedId)}/members?${query}`,
    );
    setMembers((current) => append ? [...current, ...page.items] : page.items);
    setMemberNextCursor(page.nextCursor);
    if (!append) setKeepers(new Set(page.items.filter((member) => member.decision === "keep").map((member) => member.recordId)));
  }, [selectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadGroups().catch((value: unknown) => setError(value instanceof Error ? value.message : "Duplicates could not be loaded.")), 180);
    return () => window.clearTimeout(timer);
  }, [loadGroups]);
  useEffect(() => { void loadMembers().catch((value: unknown) => setError(value instanceof Error ? value.message : "Duplicate paths could not be loaded.")); }, [loadMembers]);

  async function saveKeepers(keepEverything: boolean) {
    if (!selected) return;
    setBusy(true);
    try {
      await post(`/api/duplicates/${encodeURIComponent(selected.id)}/decision`, {
        keeperRecordIds: keepEverything ? [] : [...keepers],
        keepEverything,
      });
      setNotice(keepEverything ? "Every copy will be kept." : "Keeper decision saved. No file has moved.");
      await Promise.all([loadGroups(), loadMembers()]);
    } catch (value) { setError(value instanceof Error ? value.message : "The keeper decision could not be saved."); }
    finally { setBusy(false); }
  }

  async function verifyCandidates() {
    if (!selected) return;
    setBusy(true);
    try {
      await post(`/api/libraries/${encodeURIComponent(selected.rootId)}/analysis`, {
        requestedBy: "local-web-user",
        stages: ["content-identity"],
        hashScope: "duplicate-candidates",
      });
      await post("/api/worker/start").catch(() => undefined);
      setNotice("Selective content verification was queued. Candidate groups remain non-destructive.");
    } catch (value) { setError(value instanceof Error ? value.message : "Verification could not be queued."); }
    finally { setBusy(false); }
  }

  async function proposeConsolidation() {
    if (!selected) return;
    setBusy(true);
    try {
      const plan = await post<TransferPlan>(`/api/duplicates/${encodeURIComponent(selected.id)}/consolidation`, {
        requestedBy: "local-web-user",
      });
      setProposal(plan);
      setNotice("Recoverable quarantine proposal created. Review the explicit approval phrase before execution.");
    } catch (value) { setError(value instanceof Error ? value.message : "A consolidation proposal could not be created."); }
    finally { setBusy(false); }
  }

  async function approveProposal() {
    if (!proposal) return;
    setBusy(true);
    try {
      await post(`/api/transfers/${encodeURIComponent(proposal.id)}/approve`, {
        approvedBy: "local-web-user",
        confirmation,
      });
      await post("/api/worker/start").catch(() => undefined);
      setProposal(undefined);
      setConfirmation("");
      setNotice("Duplicate quarantine job queued. No copy is permanently deleted.");
      navigate("jobs");
    } catch (value) { setError(value instanceof Error ? value.message : "The consolidation plan could not be approved."); }
    finally { setBusy(false); }
  }

  function toggleKeeper(recordId: string) {
    setKeepers((current) => {
      const next = new Set(current);
      if (next.has(recordId)) next.delete(recordId); else next.add(recordId);
      return next;
    });
  }

  const reclaimable = groups.reduce((sum, group) => sum + (group.kind === "exact" ? group.reclaimableBytes : 0), 0);
  return (
    <div className="page-stack">
      <header className="page-header"><div><span className="eyebrow">Content identity</span><h1>Duplicates</h1><p>Candidate groups are cheap hints. Exact groups appear only after full SHA-256 verification; cleanup is always proposed and recoverable.</p></div></header>
      {error && <div className="notice notice--error">{error}</div>}
      {notice && <div className="notice notice--success">{notice}</div>}
      <section className="summary-band">
        <Summary label="Groups shown" value={groups.length.toLocaleString()} />
        <Summary label="Exact groups" value={groups.filter((group) => group.kind === "exact").length.toLocaleString()} />
        <Summary label="Candidates" value={groups.filter((group) => group.kind === "candidate").length.toLocaleString()} />
        <Summary label="Exact reclaimable" value={formatBytes(reclaimable)} />
        <Summary label="Automatic deletion" value="Never" />
      </section>
      <section className="filter-bar filter-bar--duplicates">
        <label className="search-field"><span>Search paths</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filename or path" /></label>
        <label><span>Identity</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Candidates and exact</option><option value="exact">Exact only</option><option value="candidate">Candidates only</option></select></label>
        <label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="reclaimable-desc">Most reclaimable</option><option value="copies-desc">Most copies</option><option value="size-desc">Largest file</option><option value="updated-desc">Recently updated</option></select></label>
      </section>
      <div className="duplicate-layout">
        <section className="duplicate-groups" aria-label="Duplicate groups">
          {groups.map((group) => <button className={`duplicate-group ${group.id === selectedId ? "duplicate-group--active" : ""}`} key={group.id} onClick={() => setSelectedId(group.id)}><div><strong>{group.copyCount.toLocaleString()} copies · {formatBytes(group.byteLength)} each</strong><small>{formatBytes(group.reclaimableBytes)} reclaimable · updated {formatDate(group.updatedAt)}</small></div><StatusBadge status={group.kind === "exact" ? "verified" : group.verificationState} /></button>)}
          {groups.length === 0 && <div className="quiet-card">No duplicate groups match these filters. Run analysis after a completed inventory.</div>}
          {nextCursor && <button className="button button--soft" onClick={() => void loadGroups(nextCursor, true)}>Load more groups</button>}
        </section>
        <section className="duplicate-detail">
          {!selected && <div className="quiet-card">Select a duplicate group to inspect every recorded path.</div>}
          {selected && <><div className="section-heading"><div><span className="eyebrow">{selected.kind === "exact" ? "Verified exact identity" : "Unverified candidate"}</span><h2>{selected.copyCount.toLocaleString()} copies</h2><p>{formatBytes(selected.totalBytes)} represented · {formatBytes(selected.reclaimableBytes)} reclaimable if one keeper is selected.</p></div><StatusBadge status={selected.verificationState} /></div>
            <div className="duplicate-paths">{members.map((member) => <label className="duplicate-path" key={member.recordId}><input type="checkbox" disabled={selected.kind !== "exact"} checked={keepers.has(member.recordId)} onChange={() => toggleKeeper(member.recordId)} /><div><strong>{member.name}</strong><code>{member.relativePath}</code><small>{formatDate(member.modifiedAt)} · {member.hashState.replaceAll("-", " ")}</small></div>{member.decision !== "undecided" && <StatusBadge status={member.decision} />}</label>)}</div>
            {memberNextCursor && <button className="button button--soft button--mini" onClick={() => void loadMembers(memberNextCursor, true)}>Load more paths</button>}
            <div className="card-actions duplicate-actions">
              {selected.kind === "candidate" && <button className="button button--primary" disabled={busy} onClick={() => void verifyCandidates()}>Verify candidate contents</button>}
              {selected.kind === "exact" && <><button className="button button--soft" disabled={busy} onClick={() => void saveKeepers(true)}>Keep everything</button><button className="button button--primary" disabled={busy || keepers.size === 0 || keepers.size === selected.copyCount} onClick={() => void saveKeepers(false)}>Save {keepers.size} keeper{keepers.size === 1 ? "" : "s"}</button><button className="button button--ghost" disabled={busy || selected.keeperCount === 0} onClick={() => void proposeConsolidation()}>Propose quarantine</button></>}
            </div></>}
        </section>
      </div>
      <ConfirmationDialog open={proposal !== undefined} title="Approve recoverable duplicate consolidation" confirmLabel="Queue quarantine" danger busy={busy} confirmDisabled={confirmation !== `QUARANTINE ${proposal?.counts.ready ?? 0} DUPLICATE COPIES`} onCancel={() => { setProposal(undefined); setConfirmation(""); }} onConfirm={() => void approveProposal()}>
        <p>This moves selected redundant copies into Local Librarian quarantine after re-verifying their identity. It does not permanently delete them.</p>
        <label><span>Type <code>QUARANTINE {proposal?.counts.ready ?? 0} DUPLICATE COPIES</code></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      </ConfirmationDialog>
    </div>
  );
}

function Summary({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
