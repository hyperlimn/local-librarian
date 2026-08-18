import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";

import type {
  FilesystemRootIdentity,
  FilesystemVolumeIdentity,
} from "../domain/index.js";
import type { CanonicalPathInspection } from "../safety/index.js";

export interface VolumeIdentityProvider {
  identify(
    inspection: CanonicalPathInspection,
  ): Promise<FilesystemVolumeIdentity>;
}

/** Uses mountvol read-only on Windows, with a device-ID fallback. */
export class SystemVolumeIdentityProvider implements VolumeIdentityProvider {
  public async identify(
    inspection: CanonicalPathInspection,
  ): Promise<FilesystemVolumeIdentity> {
    const volumeGuid =
      process.platform === "win32"
        ? await readWindowsVolumeGuid(inspection.mountPath)
        : undefined;
    const fileSystemTypeName = mapFileSystemType(
      inspection.fileSystemTypeCode,
    );

    if (volumeGuid !== undefined) {
      return {
        kind: "windows-volume-guid",
        key: `windows-volume-guid:${volumeGuid.toLowerCase()}`,
        stability: "stable",
        deviceId: inspection.deviceId,
        ...(inspection.fileSystemTypeCode === undefined
          ? {}
          : { fileSystemTypeCode: inspection.fileSystemTypeCode }),
        ...(fileSystemTypeName === undefined ? {} : { fileSystemTypeName }),
        volumeGuid,
        mountPathAtEnrollment: inspection.mountPath,
      };
    }

    return {
      kind: "filesystem-device",
      key: `filesystem-device:${inspection.deviceId}`,
      stability: "best-effort",
      deviceId: inspection.deviceId,
      ...(inspection.fileSystemTypeCode === undefined
        ? {}
        : { fileSystemTypeCode: inspection.fileSystemTypeCode }),
      ...(fileSystemTypeName === undefined ? {} : { fileSystemTypeName }),
      mountPathAtEnrollment: inspection.mountPath,
    };
  }
}

export function createFilesystemRootIdentity(
  inspection: CanonicalPathInspection,
  volume: FilesystemVolumeIdentity,
  platform: "win32" | "posix" =
    process.platform === "win32" ? "win32" : "posix",
): FilesystemRootIdentity {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(
    inspection.mountPath,
    inspection.canonicalPath,
  );
  if (
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    throw new Error("The canonical root is outside its identified mount path.");
  }

  const portableRelativePath =
    relative.length === 0 ? "." : relative.split(paths.sep).join("/");
  const identityRelativePath =
    platform === "win32"
      ? portableRelativePath.toLocaleLowerCase("en-US")
      : portableRelativePath;
  const digest = createHash("sha256")
    .update("local-librarian-filesystem-root-v1\0", "utf8")
    .update(volume.key, "utf8")
    .update("\0", "utf8")
    .update(identityRelativePath, "utf8")
    .digest("hex");

  return {
    formatVersion: 1,
    key: `filesystem-root-v1:${digest}`,
    volume,
    relativePathWithinVolume: portableRelativePath,
    canonicalPathAtEnrollment: inspection.canonicalPath,
  };
}

async function readWindowsVolumeGuid(
  mountPath: string,
): Promise<string | undefined> {
  try {
    const stdout = await executeFile("mountvol.exe", [mountPath, "/L"]);
    const match = /\\\\\?\\Volume\{[0-9a-f-]+\}\\?/iu.exec(stdout);
    return match?.[0].replace(/\\$/u, "");
  } catch {
    return undefined;
  }
}

function executeFile(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function mapFileSystemType(code: string | undefined): string | undefined {
  switch (code?.toLowerCase()) {
    case "0x5346544e":
      return "ntfs";
    case "0x2011bab0":
      return "exfat";
    case "0x4d44":
      return "fat";
    case "0xef53":
      return "ext-family";
    case "0x6969":
      return "nfs";
    default:
      return undefined;
  }
}

