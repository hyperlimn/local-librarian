export const THEME_STORAGE_KEY = "local-librarian.theme";
export const THEMES = ["light", "dark"] as const;

export type Theme = typeof THEMES[number];

export interface ThemePreferenceSnapshot {
  readonly storedPreference: string | null;
  readonly prefersDark: boolean;
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function resolveTheme(snapshot: ThemePreferenceSnapshot): Theme {
  return isTheme(snapshot.storedPreference)
    ? snapshot.storedPreference
    : snapshot.prefersDark
      ? "dark"
      : "light";
}

export function oppositeTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}
