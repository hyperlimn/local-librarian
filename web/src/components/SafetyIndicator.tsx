export function SafetyIndicator({
  compact = false,
  mode = "read-only",
}: {
  readonly compact?: boolean;
  readonly mode?: "read-only" | "live";
}) {
  const live = mode === "live";
  return (
    <div className={`safety-indicator ${compact ? "safety-indicator--compact" : ""} ${live ? "safety-indicator--live" : ""}`}>
      <span className="safety-indicator__icon" aria-hidden="true">{live ? "!" : "✓"}</span>
      <div>
        <strong>FILE MUTATION: {live ? "ENABLED" : "DISABLED"}</strong>
        {!compact && <p>{live
          ? "Live relocation is available only for separately write-approved libraries."
          : "Planning and precondition testing are active; files and folders cannot change."}</p>}
      </div>
    </div>
  );
}
