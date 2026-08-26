import { describe, expect, it } from "vitest";

import {
  LinuxDriveDiscovery,
  WindowsDriveDiscovery,
  type CommandExecutor,
} from "../../src/web/drive-discovery.js";

describe("WindowsDriveDiscovery", () => {
  it("uses one fixed OS metadata query and does not enumerate volume contents", async () => {
    const executor = new CapturingExecutor(JSON.stringify([
      { DeviceID: "C:", VolumeName: "System", FileSystem: "NTFS", Size: "1000", FreeSpace: "250", DriveType: 3 },
      { DeviceID: "E:", VolumeName: "CAMERA", FileSystem: "exFAT", Size: "500", FreeSpace: "400", DriveType: 2 },
    ]));
    const volumes = await new WindowsDriveDiscovery(executor, "win32").discover();
    expect(volumes).toEqual([
      { mountPath: "C:\\", driveLetter: "C:", label: "System", filesystem: "NTFS", totalBytes: 1000, freeBytes: 250, classification: "fixed" },
      { mountPath: "E:\\", driveLetter: "E:", label: "CAMERA", filesystem: "exFAT", totalBytes: 500, freeBytes: 400, classification: "removable" },
    ]);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.file).toBe("powershell.exe");
    expect(executor.calls[0]?.arguments.join(" ")).toContain("Win32_LogicalDisk");
    expect(executor.calls[0]?.arguments.join(" ")).not.toContain("Get-ChildItem");
  });

  it("does nothing on non-Windows platforms", async () => {
    const executor = new CapturingExecutor("[]");
    await expect(new WindowsDriveDiscovery(executor, "linux").discover()).resolves.toEqual([]);
    expect(executor.calls).toHaveLength(0);
  });
});

describe("LinuxDriveDiscovery", () => {
  it("uses fixed read-only mount metadata queries without scanning mounted contents", async () => {
    const executor = new RoutingExecutor({
      findmnt: JSON.stringify({ filesystems: [
        {
          target: "/",
          source: "/dev/nvme0n1p2",
          fstype: "ext4",
          size: 1_000_000,
          avail: 400_000,
          options: "rw,relatime",
          label: "System",
          uuid: "root-uuid",
        },
        {
          target: "/media/mark/CAMERA",
          source: "/dev/sdb1",
          fstype: "exfat",
          size: 500_000,
          avail: 300_000,
          options: "ro,nosuid",
          label: "CAMERA",
          uuid: "camera-uuid",
        },
      ] }),
      lsblk: JSON.stringify({ blockdevices: [
        {
          path: "/dev/nvme0n1p2", type: "part", fstype: "ext4", label: "System",
          uuid: "root-uuid", mountpoints: ["/"], size: 1_000_000,
          rm: false, ro: false, hotplug: false, tran: "nvme",
        },
        {
          path: "/dev/sdb1", type: "part", fstype: "exfat", label: "CAMERA",
          uuid: "camera-uuid", mountpoints: ["/media/mark/CAMERA"], size: 500_000,
          rm: true, ro: true, hotplug: true, tran: "usb",
        },
      ] }),
    });

    await expect(new LinuxDriveDiscovery(executor, "linux").discover()).resolves.toEqual([
      {
        mountPath: "/",
        deviceIdentity: "root-uuid",
        label: "System",
        filesystem: "ext4",
        totalBytes: 1_000_000,
        freeBytes: 400_000,
        readOnly: false,
        transport: "nvme",
        classification: "fixed",
      },
      {
        mountPath: "/media/mark/CAMERA",
        deviceIdentity: "camera-uuid",
        label: "CAMERA",
        filesystem: "exfat",
        totalBytes: 500_000,
        freeBytes: 300_000,
        readOnly: true,
        transport: "usb",
        classification: "removable",
      },
    ]);
    expect(executor.calls.map((call) => call.file)).toEqual(["findmnt", "lsblk"]);
    expect(executor.calls.flatMap((call) => call.arguments).join(" ")).not.toMatch(/find|grep|du|walk/iu);
  });

  it("does nothing on non-Linux platforms", async () => {
    const executor = new RoutingExecutor({});
    await expect(new LinuxDriveDiscovery(executor, "darwin").discover()).resolves.toEqual([]);
    expect(executor.calls).toHaveLength(0);
  });
});

class CapturingExecutor implements CommandExecutor {
  public readonly calls: Array<{ file: string; arguments: readonly string[] }> = [];
  public constructor(private readonly output: string) {}
  public execute(file: string, arguments_: readonly string[]): Promise<string> {
    this.calls.push({ file, arguments: arguments_ });
    return Promise.resolve(this.output);
  }
}

class RoutingExecutor implements CommandExecutor {
  public readonly calls: Array<{ file: string; arguments: readonly string[] }> = [];
  public constructor(private readonly outputs: Readonly<Record<string, string>>) {}
  public execute(file: string, arguments_: readonly string[]): Promise<string> {
    this.calls.push({ file, arguments: arguments_ });
    const output = this.outputs[file];
    return output === undefined ? Promise.reject(new Error(`Unexpected command: ${file}`)) : Promise.resolve(output);
  }
}
