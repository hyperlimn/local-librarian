import { elapsed, formatBytes } from "../format";
import type { Scan } from "../types";
import { StatusBadge } from "./StatusBadge";

export function ScanProgress({ scan, progress }: {
  readonly scan: Scan;
  readonly progress?: {
    metrics?: {
      filesDiscovered?: number;
      directoriesVisited?: number;
      bytesRepresented?: number;
      skippedEntries?: number;
      errorEntries?: number;
      currentRelativeLocation?: string;
    };
  } | undefined;
}) {
  const metrics = progress?.metrics;
  const counts = {
    files: metrics?.filesDiscovered ?? scan.counts.filesDiscovered,
    directories: metrics?.directoriesVisited ?? scan.counts.directoriesVisited,
    bytes: metrics?.bytesRepresented ?? scan.counts.bytesRepresented,
    skips: metrics?.skippedEntries ?? scan.counts.skippedEntries,
    errors: metrics?.errorEntries ?? scan.counts.errorEntries,
  };
  const location = metrics?.currentRelativeLocation ?? scan.checkpoint?.currentRelativePath ?? ".";
  return (
    <section className="scan-progress">
      <div className="scan-progress__head">
        <div>
          <span className="eyebrow">Current scan</span>
          <h3>{scan.status === "running" ? "Inventory in progress" : "Inventory scan"}</h3>
        </div>
        <StatusBadge status={scan.status} />
      </div>
      {scan.status === "running" && (
        <div className="indeterminate-track" aria-label="Scan progress has an unknown total"><span /></div>
      )}
      <div className="metric-row metric-row--five">
        <Metric label="Files" value={counts.files.toLocaleString()} />
        <Metric label="Directories" value={counts.directories.toLocaleString()} />
        <Metric label="Represented" value={formatBytes(counts.bytes)} />
        <Metric label="Skips" value={counts.skips.toLocaleString()} />
        <Metric label="Errors" value={counts.errors.toLocaleString()} tone={counts.errors > 0 ? "bad" : undefined} />
      </div>
      <div className="current-location">
        <span>Current location</span>
        <code title={location}>{location}</code>
        <small>Elapsed {elapsed(scan.startedAt, scan.completedAt)}</small>
      </div>
    </section>
  );
}

function Metric({ label, value, tone }: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "bad" | undefined;
}) {
  return <div className={`metric ${tone === undefined ? "" : `metric--${tone}`}`}><strong>{value}</strong><span>{label}</span></div>;
}
