import { homedir } from "node:os";
import { posix, resolve, win32, type PlatformPath } from "node:path";

export const LOCAL_STATE_DIRECTORY_ENVIRONMENT_VARIABLE =
  "LOCAL_LIBRARIAN_STATE_DIR" as const;

export interface LocalStateDirectoryResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly homeDirectory?: string;
  readonly workingDirectory?: string;
}

export interface LocalStatePaths {
  readonly directory: string;
  readonly jobsDatabase: string;
  readonly inventoryDatabase: string;
  readonly enrollmentsJournal: string;
  readonly workerStatus: string;
}

/**
 * Resolves app-owned state outside the source tree by default. An explicit
 * argument wins, followed by LOCAL_LIBRARIAN_STATE_DIR, then the platform's
 * conventional per-user application-state location.
 */
export function resolveLocalStateDirectory(
  explicitDirectory?: string,
  options: LocalStateDirectoryResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathApi = platformPath(platform);
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const override = nonEmpty(explicitDirectory) ??
    nonEmpty(environment[LOCAL_STATE_DIRECTORY_ENVIRONMENT_VARIABLE]);
  if (override !== undefined) {
    return pathApi.resolve(workingDirectory, override);
  }

  if (platform === "win32") {
    const localApplicationData = nonEmpty(environment["LOCALAPPDATA"]) ??
      pathApi.join(homeDirectory, "AppData", "Local");
    return pathApi.resolve(localApplicationData, "LocalLibrarian");
  }
  if (platform === "darwin") {
    return pathApi.resolve(
      homeDirectory,
      "Library",
      "Application Support",
      "LocalLibrarian",
    );
  }
  const xdgStateHome = nonEmpty(environment["XDG_STATE_HOME"]) ??
    pathApi.join(homeDirectory, ".local", "state");
  return pathApi.resolve(xdgStateHome, "local-librarian");
}

export function localStatePaths(directory: string): LocalStatePaths {
  const absolute = resolve(directory);
  return {
    directory: absolute,
    jobsDatabase: resolve(absolute, "jobs.sqlite"),
    inventoryDatabase: resolve(absolute, "inventory.sqlite"),
    enrollmentsJournal: resolve(absolute, "enrollments.jsonl"),
    workerStatus: resolve(absolute, "worker-status.json"),
  };
}

function platformPath(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
