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
  readonly deviceIdentity?: string;
  readonly label?: string;
  readonly filesystem?: string;
  readonly totalBytes?: number;
  readonly freeBytes?: number;
  readonly readOnly?: boolean;
  readonly transport?: string;
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

const LINUX_FINDMNT_ARGUMENTS = [
  "--json",
  "--bytes",
  "--real",
  "--output",
  "TARGET,SOURCE,FSTYPE,SIZE,AVAIL,OPTIONS,LABEL,UUID",
] as const;

const LINUX_LSBLK_ARGUMENTS = [
  "--json",
  "--bytes",
  "--paths",
  "--output",
  "PATH,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINTS,SIZE,RM,RO,HOTPLUG,TRAN",
] as const;

/** Read-only util-linux metadata queries; it never walks or opens volume contents. */
export class LinuxDriveDiscovery implements DriveDiscovery {
  public constructor(
    private readonly executor: CommandExecutor = new ExecFileCommandExecutor(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async discover(): Promise<readonly DiscoveredVolume[]> {
    if (this.platform !== "linux") return [];
    const findmntOutput = await this.executor.execute("findmnt", LINUX_FINDMNT_ARGUMENTS);
    const blockOutput = await this.executor.execute("lsblk", LINUX_LSBLK_ARGUMENTS).catch(() => "{}");
    const mounts = parseFindmnt(findmntOutput);
    const blockByMount = new Map<string, LinuxBlockRow>();
    for (const block of parseLsblk(blockOutput)) {
      for (const mount of block.mountpoints ?? []) {
        if (typeof mount === "string" && mount.startsWith("/")) blockByMount.set(mount, block);
      }
    }
    return mounts
      .filter((mount) => mount.target.startsWith("/"))
      .map((mount): DiscoveredVolume => {
        const block = blockByMount.get(mount.target);
        const label = nonEmpty(mount.label) ?? nonEmpty(block?.label ?? null);
        const filesystem = nonEmpty(mount.fstype);
        const identity = nonEmpty(mount.uuid) ?? nonEmpty(block?.uuid ?? null) ?? nonEmpty(mount.source);
        const transport = nonEmpty(block?.tran ?? null);
        return {
          mountPath: mount.target,
          ...(identity === undefined ? {} : { deviceIdentity: identity }),
          ...(label === undefined ? {} : { label }),
          ...(filesystem === undefined ? {} : { filesystem }),
          ...optionalLinuxCapacity(mount.size, "totalBytes"),
          ...optionalLinuxCapacity(mount.avail, "freeBytes"),
          readOnly: mount.options?.split(",").includes("ro") ?? block?.ro === true,
          ...(transport === undefined ? {} : { transport }),
          classification: linuxClassification(mount, block),
        };
      })
      .sort((left, right) => left.mountPath.localeCompare(right.mountPath));
  }
}

export class SystemDriveDiscovery implements DriveDiscovery {
  public constructor(
    private readonly executor: CommandExecutor = new ExecFileCommandExecutor(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public discover(): Promise<readonly DiscoveredVolume[]> {
    if (this.platform === "win32") return new WindowsDriveDiscovery(this.executor, this.platform).discover();
    if (this.platform === "linux") return new LinuxDriveDiscovery(this.executor, this.platform).discover();
    return Promise.resolve([]);
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

interface LinuxMountRow {
  readonly target: string;
  readonly source: string | null;
  readonly fstype: string | null;
  readonly size: number | string | null;
  readonly avail: number | string | null;
  readonly options: string | null;
  readonly label: string | null;
  readonly uuid: string | null;
}

interface LinuxBlockRow {
  readonly path: string | null;
  readonly type: string | null;
  readonly fstype: string | null;
  readonly label: string | null;
  readonly uuid: string | null;
  readonly mountpoints: readonly (string | null)[] | null;
  readonly size: number | string | null;
  readonly rm: boolean | number;
  readonly ro: boolean | number;
  readonly hotplug: boolean | number;
  readonly tran: string | null;
  readonly children?: readonly LinuxBlockRow[];
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

function parseFindmnt(output: string): readonly LinuxMountRow[] {
  if (output.trim().length === 0) return [];
  const parsed = JSON.parse(output) as unknown;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>)["filesystems"])) {
    return [];
  }
  return ((parsed as { filesystems: unknown[] }).filesystems).filter(isLinuxMountRow);
}

function isLinuxMountRow(value: unknown): value is LinuxMountRow {
  return typeof value === "object" && value !== null &&
    typeof (value as Record<string, unknown>)["target"] === "string";
}

function parseLsblk(output: string): readonly LinuxBlockRow[] {
  if (output.trim().length === 0) return [];
  const parsed = JSON.parse(output) as unknown;
  const roots = typeof parsed === "object" && parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>)["blockdevices"])
    ? (parsed as { blockdevices: unknown[] }).blockdevices.filter(isLinuxBlockRow)
    : [];
  const result: LinuxBlockRow[] = [];
  const visit = (row: LinuxBlockRow): void => {
    result.push(row);
    for (const child of row.children ?? []) visit(child);
  };
  for (const row of roots) visit(row);
  return result;
}

function isLinuxBlockRow(value: unknown): value is LinuxBlockRow {
  return typeof value === "object" && value !== null;
}

function optionalLinuxCapacity(
  value: number | string | null,
  key: "totalBytes" | "freeBytes",
): { readonly totalBytes?: number; readonly freeBytes?: number } {
  if (value === null) return {};
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? { [key]: number } : {};
}

function linuxClassification(
  mount: LinuxMountRow,
  block: LinuxBlockRow | undefined,
): DriveClassification {
  const filesystem = mount.fstype?.toLocaleLowerCase("en-US") ?? "";
  if (["nfs", "nfs4", "cifs", "smb3", "sshfs", "9p", "afs"].includes(filesystem)) return "network";
  if (["iso9660", "udf"].includes(filesystem) || block?.type === "rom") return "optical";
  if (["tmpfs", "ramfs"].includes(filesystem)) return "ram-disk";
  if (
    block?.rm === true || block?.rm === 1 ||
    block?.hotplug === true || block?.hotplug === 1 ||
    ["usb", "mmc"].includes(block?.tran?.toLocaleLowerCase("en-US") ?? "")
  ) return "removable";
  if (mount.source?.startsWith("/dev/") || block !== undefined) return "fixed";
  return "unknown";
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
