export function SafetyIndicator({ compact = false }: { readonly compact?: boolean }) {
  return (
    <div className={`safety-indicator ${compact ? "safety-indicator--compact" : ""}`}>
      <span className="safety-indicator__icon" aria-hidden="true">✓</span>
      <div>
        <strong>FILE MUTATION: DISABLED</strong>
        {!compact && <p>Metadata-only access. No content reads, hashing, moves, copies, or deletes.</p>}
      </div>
    </div>
  );
}
