import { formatBytes, formatDate } from "../format";
import type { InventoryRecord } from "../types";
import { StatusBadge } from "./StatusBadge";

export function InventoryTable({ records, loading }: {
  readonly records: readonly InventoryRecord[];
  readonly loading?: boolean;
}) {
  return (
    <div className="table-shell">
      <table className="inventory-table">
        <thead><tr>
          <th>Name</th><th>Relative path</th><th>Type</th><th>Extension</th>
          <th className="numeric">Size</th><th>Created</th><th>Modified</th><th>Scan</th>
        </tr></thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className={record.observationStatus !== "observed" ? "row--attention" : ""}>
              <td><div className="file-cell"><span className={`file-icon file-icon--${record.entryType}`}>{record.entryType === "directory" ? "D" : "F"}</span><span><strong>{record.name}</strong>{record.issue && <small title={record.issue.message}>{record.issue.code}</small>}</span></div></td>
              <td><code className="path-cell" title={record.relativePath}>{record.relativePath}</code></td>
              <td><StatusBadge status={record.observationStatus} /><span className="type-copy">{record.entryType}</span></td>
              <td>{record.extension ?? "—"}</td>
              <td className="numeric">{formatBytes(record.byteLength)}</td>
              <td>{formatDate(record.createdAt)}</td>
              <td>{formatDate(record.modifiedAt)}</td>
              <td><code title={record.scanId}>{record.scanId.slice(-8)}</code></td>
            </tr>
          ))}
          {!loading && records.length === 0 && <tr><td colSpan={8} className="empty-table">No inventory observations match these filters.</td></tr>}
          {loading && <tr><td colSpan={8} className="empty-table">Loading inventory…</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
