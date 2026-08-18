import { formatBytes, formatDate } from "../format";
import type { LibraryView } from "../types";
import { StatusBadge } from "./StatusBadge";

export function LibraryCard({ library, onScan, onBrowse, onRevoke }: {
  readonly library: LibraryView;
  readonly onScan?: (() => void) | undefined;
  readonly onBrowse?: (() => void) | undefined;
  readonly onRevoke?: (() => void) | undefined;
}) {
  const { root, summary } = library;
  return (
    <article className="library-card">
      <div className="library-card__top">
        <div className="library-glyph" aria-hidden="true">L</div>
        <div className="library-card__identity">
          <h3>{root.displayName}</h3>
          <p title={root.displayPath}>{root.displayPath}</p>
        </div>
        <StatusBadge status={root.approval.status} />
      </div>
      <dl className="detail-grid">
        <div><dt>Last scan</dt><dd>{formatDate(summary.latestScan?.completedAt ?? summary.latestScan?.startedAt)}</dd></div>
        <div><dt>Files</dt><dd>{summary.latestScan?.counts.filesDiscovered.toLocaleString() ?? "—"}</dd></div>
        <div><dt>Represented</dt><dd>{formatBytes(summary.latestScan?.counts.bytesRepresented)}</dd></div>
        <div><dt>Scans retained</dt><dd>{summary.retainedScanCount}</dd></div>
      </dl>
      <div className="card-actions">
        {root.approval.status === "approved" && onScan && <button className="button button--primary" onClick={onScan}>Start scan</button>}
        {onBrowse && <button className="button button--soft" onClick={onBrowse}>Browse inventory</button>}
        {root.approval.status === "approved" && onRevoke && <button className="button button--text button--danger-text" onClick={onRevoke}>Revoke</button>}
      </div>
    </article>
  );
}
