import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  THEME_STORAGE_KEY,
  isTheme,
  oppositeTheme,
  resolveTheme,
} from "../../web/src/theme.js";

describe("WebUI theme preference", () => {
  it("gives a valid saved preference priority over the operating-system preference", () => {
    expect(resolveTheme({ storedPreference: "light", prefersDark: true })).toBe("light");
    expect(resolveTheme({ storedPreference: "dark", prefersDark: false })).toBe("dark");
  });

  it("uses prefers-color-scheme on first use or after an invalid saved value", () => {
    expect(resolveTheme({ storedPreference: null, prefersDark: true })).toBe("dark");
    expect(resolveTheme({ storedPreference: "unknown", prefersDark: false })).toBe("light");
    expect(isTheme("sepia")).toBe(false);
    expect(oppositeTheme("light")).toBe("dark");
    expect(oppositeTheme("dark")).toBe("light");
  });

  it("applies the saved theme in the synchronous head initializer", async () => {
    const result = await runInitializer("dark", false);
    expect(result).toEqual({
      datasetTheme: "dark",
      colorScheme: "dark",
      metaColor: "#101b18",
      requestedKey: THEME_STORAGE_KEY,
    });
  });

  it("applies the operating-system preference before React when storage is empty", async () => {
    expect(await runInitializer(null, true)).toMatchObject({
      datasetTheme: "dark",
      colorScheme: "dark",
    });
    expect(await runInitializer(null, false)).toMatchObject({
      datasetTheme: "light",
      colorScheme: "light",
    });
  });
});

async function runInitializer(stored: string | null, prefersDark: boolean) {
  const source = await readFile(new URL("../../web/public/assets/theme-init.js", import.meta.url), "utf8");
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  let metaColor = "";
  let requestedKey = "";
  runInNewContext(source, {
    window: {
      localStorage: {
        getItem: (key: string) => { requestedKey = key; return stored; },
      },
      matchMedia: () => ({ matches: prefersDark }),
    },
    document: {
      documentElement: { dataset, style },
      querySelector: () => ({
        setAttribute: (_name: string, value: string) => { metaColor = value; },
      }),
    },
  });
  return {
    datasetTheme: dataset["theme"],
    colorScheme: style["colorScheme"],
    metaColor,
    requestedKey,
  };
}
