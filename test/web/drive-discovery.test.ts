import { describe, expect, it } from "vitest";

import {
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

class CapturingExecutor implements CommandExecutor {
  public readonly calls: Array<{ file: string; arguments: readonly string[] }> = [];
  public constructor(private readonly output: string) {}
  public execute(file: string, arguments_: readonly string[]): Promise<string> {
    this.calls.push({ file, arguments: arguments_ });
    return Promise.resolve(this.output);
  }
}
