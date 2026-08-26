import { useCallback, useEffect, useState } from "react";

import { api, post } from "../api";
import type { ResourceSettings } from "../types";

export function SettingsPage() {
  const [settings, setSettings] = useState<ResourceSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    try {
      setSettings(await api<ResourceSettings>("/api/settings/resources"));
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Settings could not be loaded.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (settings === undefined) return;
    setBusy(true);
    try {
      setSettings(await post<ResourceSettings>("/api/settings/resources", settings));
      setNotice("Resource controls saved locally.");
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  function update<K extends keyof ResourceSettings>(key: K, value: ResourceSettings[K]) {
    setSettings((current) => current === undefined ? current : { ...current, [key]: value });
  }

  if (settings === undefined) {
    return <div className="page-state"><div className="spinner" /><h1>Loading settings</h1><p>{error ?? "Reading local resource policy…"}</p></div>;
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <span className="eyebrow">Consumer-hardware controls</span>
          <h1>Settings</h1>
          <p>Choose how aggressively Local Librarian reads disks. Conservative defaults favor sequential work and low contention.</p>
        </div>
      </header>
      {error && <div className="notice notice--error">{error}</div>}
      {notice && <div className="notice notice--success">{notice}</div>}

      <section className="settings-grid">
        <article className="settings-card">
          <div><span className="eyebrow">I/O behavior</span><h2>Throughput</h2><p>Disk-friendly is safest for spinning drives. Maximum throughput is intended for fast local SSDs.</p></div>
          <label><span>Work profile</span><select value={settings.throughputMode} onChange={(event) => update("throughputMode", event.target.value as ResourceSettings["throughputMode"])}><option value="disk-friendly">Disk-friendly</option><option value="balanced">Balanced</option><option value="maximum">Maximum throughput</option></select></label>
          <label className="checkbox-control settings-check"><input type="checkbox" checked={settings.pauseHeavyWork} onChange={(event) => update("pauseHeavyWork", event.target.checked)} /><span>Pause new heavy analysis</span></label>
        </article>

        <article className="settings-card">
          <div><span className="eyebrow">Bounded concurrency</span><h2>Analysis workers</h2><p>Individual jobs remain durable. These limits bound parallel hashing and metadata reads.</p></div>
          <label><span>Hashing workers</span><input type="number" min={1} max={8} value={settings.maximumHashingWorkers} onChange={(event) => update("maximumHashingWorkers", Number(event.target.value))} /></label>
          <label><span>Metadata analyzers</span><input type="number" min={1} max={16} value={settings.metadataConcurrency} onChange={(event) => update("metadataConcurrency", Number(event.target.value))} /></label>
          <p><strong>Transfers are serialized in 2.0.</strong> Each local worker processes one transfer-plan item at a time so checkpoint and verification order stays explicit.</p>
        </article>

        <article className="settings-card">
          <div><span className="eyebrow">Progressive understanding</span><h2>Analysis depth</h2><p>This is the default for API-started analysis and the recommended choice on Analyze. Each browser-started run still states its exact stages and hash scope.</p></div>
          <label><span>Preferred depth</span><select value={settings.analysisDepth} onChange={(event) => update("analysisDepth", event.target.value as ResourceSettings["analysisDepth"])}><option value="essentials">Essentials</option><option value="standard">Standard (recommended)</option><option value="deep">Deep</option></select></label>
        </article>

        <article className="settings-card settings-card--wide">
          <div><span className="eyebrow">Optional and local</span><h2>Local model classifier</h2><p>Disabled by default. Only an HTTP loopback endpoint is accepted; GPS and location fields are filtered from model evidence, and no hosted inference adapter is included.</p></div>
          <label className="checkbox-control settings-check"><input type="checkbox" checked={settings.localModel.enabled} onChange={(event) => setSettings((current) => current === undefined ? current : { ...current, localModel: { ...current.localModel, enabled: event.target.checked } })} /><span>Enable optional local classification</span></label>
          <div className="settings-inline">
            <label><span>Adapter</span><select value={settings.localModel.adapter} onChange={(event) => setSettings((current) => current === undefined ? current : { ...current, localModel: { ...current.localModel, adapter: event.target.value as ResourceSettings["localModel"]["adapter"] } })}><option value="ollama">Ollama</option><option value="custom">Structured local HTTP</option></select></label>
            <label><span>Loopback endpoint</span><input value={settings.localModel.endpoint} onChange={(event) => setSettings((current) => current === undefined ? current : { ...current, localModel: { ...current.localModel, endpoint: event.target.value } })} /></label>
            <label><span>Model</span><input value={settings.localModel.model} placeholder="No model selected" onChange={(event) => setSettings((current) => current === undefined ? current : { ...current, localModel: { ...current.localModel, model: event.target.value } })} /></label>
          </div>
          <label className="checkbox-control settings-check"><input type="checkbox" checked={settings.localModel.allowTextSamples} onChange={(event) => setSettings((current) => current === undefined ? current : { ...current, localModel: { ...current.localModel, allowTextSamples: event.target.checked } })} /><span>Allow explicitly enabled small text samples (not used by the current classifier)</span></label>
        </article>
      </section>

      <div className="execution-panel">
        <div><h2>Apply local policy</h2><p>Changing limits does not mutate library files. Active work observes controls at safe checkpoints; queued heavy analysis can be paused from Jobs.</p></div>
        <button className="button button--primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save settings"}</button>
      </div>
    </div>
  );
}
