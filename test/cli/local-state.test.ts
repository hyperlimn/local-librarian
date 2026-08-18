import { describe, expect, it } from "vitest";

import {
  LOCAL_STATE_DIRECTORY_ENVIRONMENT_VARIABLE,
  resolveLocalStateDirectory,
} from "../../src/cli/local-state.js";

describe("resolveLocalStateDirectory", () => {
  it("uses an explicit directory before environment or platform defaults", () => {
    expect(resolveLocalStateDirectory("C:\\explicit-state", {
      platform: "win32",
      environment: {
        [LOCAL_STATE_DIRECTORY_ENVIRONMENT_VARIABLE]: "C:\\environment-state",
        LOCALAPPDATA: "C:\\Profiles\\example\\AppData\\Local",
      },
      homeDirectory: "C:\\Profiles\\example",
      workingDirectory: "C:\\workspace",
    })).toBe("C:\\explicit-state");
  });

  it("supports the environment override for development and testing", () => {
    expect(resolveLocalStateDirectory(undefined, {
      platform: "linux",
      environment: {
        [LOCAL_STATE_DIRECTORY_ENVIRONMENT_VARIABLE]: "./isolated-state",
      },
      homeDirectory: "/example-home",
      workingDirectory: "/workspace/project",
    })).toBe("/workspace/project/isolated-state");
  });

  it("uses LOCALAPPDATA on Windows without placing state in the repository", () => {
    expect(resolveLocalStateDirectory(undefined, {
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Profiles\\example\\AppData\\Local" },
      homeDirectory: "C:\\Profiles\\example",
      workingDirectory: "C:\\workspace",
    })).toBe("C:\\Profiles\\example\\AppData\\Local\\LocalLibrarian");
  });

  it("uses macOS Application Support", () => {
    expect(resolveLocalStateDirectory(undefined, {
      platform: "darwin",
      environment: {},
      homeDirectory: "/example-home",
      workingDirectory: "/workspace",
    })).toBe("/example-home/Library/Application Support/LocalLibrarian");
  });

  it("uses XDG_STATE_HOME on Linux and its standard fallback", () => {
    expect(resolveLocalStateDirectory(undefined, {
      platform: "linux",
      environment: { XDG_STATE_HOME: "/private/state" },
      homeDirectory: "/example-home",
      workingDirectory: "/workspace",
    })).toBe("/private/state/local-librarian");
    expect(resolveLocalStateDirectory(undefined, {
      platform: "linux",
      environment: {},
      homeDirectory: "/example-home",
      workingDirectory: "/workspace",
    })).toBe("/example-home/.local/state/local-librarian");
  });
});
