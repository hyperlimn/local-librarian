import { useCallback, useEffect, useState } from "react";

import {
  THEME_STORAGE_KEY,
  isTheme,
  oppositeTheme,
  resolveTheme,
  type Theme,
} from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLORS: Record<Theme, string> = {
  light: "#173d32",
  dark: "#101b18",
};

export interface ThemeController {
  readonly theme: Theme;
  readonly setTheme: (theme: Theme) => void;
  readonly toggleTheme: () => void;
}

export function useTheme(): ThemeController {
  const [theme, setThemeState] = useState<Theme>(() => initialTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const followSystemTheme = (event: MediaQueryListEvent): void => {
      if (!isTheme(readStoredTheme())) setThemeState(event.matches ? "dark" : "light");
    };
    query.addEventListener("change", followSystemTheme);
    return () => query.removeEventListener("change", followSystemTheme);
  }, []);

  const setTheme = useCallback((nextTheme: Theme): void => {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme); } catch { /* Preference persistence is best-effort. */ }
    applyTheme(nextTheme);
    setThemeState(nextTheme);
  }, []);

  const toggleTheme = useCallback((): void => {
    setThemeState((current) => {
      const nextTheme = oppositeTheme(current);
      try { window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme); } catch { /* Preference persistence is best-effort. */ }
      applyTheme(nextTheme);
      return nextTheme;
    });
  }, []);

  return { theme, setTheme, toggleTheme };
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

function initialTheme(): Theme {
  const initializedTheme = document.documentElement.dataset["theme"];
  if (isTheme(initializedTheme)) return initializedTheme;
  return resolveTheme({
    storedPreference: readStoredTheme(),
    prefersDark: window.matchMedia(DARK_QUERY).matches,
  });
}

function readStoredTheme(): string | null {
  try { return window.localStorage.getItem(THEME_STORAGE_KEY); }
  catch { return null; }
}
