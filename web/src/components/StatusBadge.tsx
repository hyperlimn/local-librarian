import type { Status } from "../types";

export function StatusBadge({ status }: { readonly status: Status | string }) {
  return <span className={`status status--${status}`}>{status.replaceAll("-", " ")}</span>;
}
