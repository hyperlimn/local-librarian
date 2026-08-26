import { describe, expect, it } from "vitest";

import { inventoryEntryAttributes } from "../../src/scanner/inventory-scan-job.js";

describe("inventoryEntryAttributes", () => {
  it("records portable POSIX evidence from names and permission bits", () => {
    expect(inventoryEntryAttributes(".private", 0o444n, "linux")).toEqual({
      hidden: true,
      readOnly: true,
    });
    expect(inventoryEntryAttributes("ordinary.txt", 0o644n, "darwin")).toEqual({
      hidden: false,
      readOnly: false,
    });
  });

  it("does not fabricate Windows attributes from POSIX conventions", () => {
    expect(inventoryEntryAttributes(".private", 0o444n, "win32")).toEqual({});
  });
});
