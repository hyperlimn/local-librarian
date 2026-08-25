import type { ReactNode } from "react";

export function ConfirmationDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  hideCancel = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly hideCancel?: boolean;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog__mark" aria-hidden="true">{danger ? "!" : "✓"}</div>
        <h2 id="dialog-title">{title}</h2>
        <div className="dialog__content">{children}</div>
        <div className="dialog__actions">
          {!hideCancel && <button className="button button--ghost" onClick={onCancel} disabled={busy}>Cancel</button>}
          <button className={`button ${danger ? "button--danger" : "button--primary"}`} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
