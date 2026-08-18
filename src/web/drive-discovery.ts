import { execFile } from "node:child_process";

export type DriveClassification =
  | "removable"
  | "fixed"
  | "network"
  | "optical"
  | "ram-disk"
  | "unknown";

export interface DiscoveredVolume {
  readonly mountPath: string;
  readonly driveLetter?: string;
  readonly label?: string;
  readonly filesystem?: string;
  readonly totalBytes?: number;
  readonly freeBytes?: number;
  readonly classification: DriveClassification;
}

export interface DriveDiscovery {
  discover(): Promise<readonly DiscoveredVolume[]>;
}

export interface CommandExecutor {
  execute(file: string, arguments_: readonly string[]): Promise<string>;
}

const WINDOWS_VOLUME_QUERY = [
  "$ErrorActionPreference='Stop'",
  "Get-CimInstance Win32_LogicalDisk |",
  "Select-Object DeviceID,VolumeName,FileSystem,@{N='Size';E={[string]$_.Size}},@{N='FreeSpace';E={[string]$_.FreeSpace}},DriveType |",
  "ConvertTo-Json -Compress",
].join(" ");

/** Fixed, read-only OS volume query. It accepts no caller-provided command text. */
export class WindowsDriveDiscovery implements DriveDiscovery {
  public constructor(
    private readonly executor: CommandExecutor = new ExecFileCommandExecutor(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async discover(): Promise<readonly DiscoveredVolume[]> {
    if (this.platform !== "win32") return [];
    const output = await this.executor.execute("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_VOLUME_QUERY,
    ]);
    if (output.trim().length === 0) return [];
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter(isLogicalDiskRow).map((row) => {
      const label = nonEmpty(row.VolumeName);
      const filesystem = nonEmpty(row.FileSystem);
      return {
        mountPath: `${row.DeviceID}\\`,
        driveLetter: row.DeviceID,
        ...(label === undefined ? {} : { label }),
        ...(filesystem === undefined ? {} : { filesystem }),
        ...optionalCapacity(row.Size, "totalBytes"),
        ...optionalCapacity(row.FreeSpace, "freeBytes"),
        classification: classification(row.DriveType),
      };
    });
  }
}

class ExecFileCommandExecutor implements CommandExecutor {
  public execute(file: string, arguments_: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...arguments_],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          if (error !== null) reject(error);
          else resolve(stdout);
        },
      );
    });
  }
}

interface LogicalDiskRow {
  readonly DeviceID: string;
  readonly VolumeName: string | null;
  readonly FileSystem: string | null;
  readonly Size: string | null;
  readonly FreeSpace: string | null;
  readonly DriveType: number;
}

function isLogicalDiskRow(value: unknown): value is LogicalDiskRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["DeviceID"] === "string" &&
    /^[A-Za-z]:$/u.test(row["DeviceID"]) &&
    typeof row["DriveType"] === "number"
  );
}

function optionalCapacity(
  value: string | null,
  key: "totalBytes" | "freeBytes",
): { readonly totalBytes?: number; readonly freeBytes?: number } {
  if (value === null) return {};
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? { [key]: number } : {};
}

function nonEmpty(value: string | null): string | undefined {
  return value === null || value.trim().length === 0 ? undefined : value;
}

function classification(value: number): DriveClassification {
  switch (value) {
    case 2:
      return "removable";
    case 3:
      return "fixed";
    case 4:
      return "network";
    case 5:
      return "optical";
    case 6:
      return "ram-disk";
    default:
      return "unknown";
  }
}
