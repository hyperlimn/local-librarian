import type { Theme } from "../theme";

export function ThemeToggle({ theme, onToggle, compact = false }: {
  readonly theme: Theme;
  readonly onToggle: () => void;
  readonly compact?: boolean;
}) {
  const nextTheme = theme === "light" ? "dark" : "light";
  return (
    <button
      className={`theme-toggle ${compact ? "theme-toggle--compact" : ""}`}
      type="button"
      aria-label={`Switch to ${nextTheme} mode`}
      aria-pressed={theme === "dark"}
      title={`Switch to ${nextTheme} mode`}
      onClick={onToggle}
    >
      {!compact && <span className="theme-toggle__copy"><small>Appearance</small><strong>{theme} mode</strong></span>}
      <span className="theme-toggle__track" aria-hidden="true">
        <span className="theme-toggle__thumb">
          {theme === "light" ? <SunIcon /> : <MoonIcon />}
        </span>
      </span>
    </button>
  );
}

function SunIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

function MoonIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" /></svg>;
}
