import { describe, expect, it } from "vitest";

import { selectTransferStrategy } from "../../src/ingest/index.js";

describe("selectTransferStrategy", () => {
  it("expands a cross-filesystem relocation into copy, verify, quarantine", () => {
    expect(selectTransferStrategy("relocate", "cross-filesystem")).toEqual({
      status: "planned",
      strategy: "cross-filesystem-copy-verify-quarantine-source",
      steps: [
        "copy-to-destination",
        "verify-content-identity",
        "quarantine-source",
      ],
    });
  });

  it("uses rename semantics only on a known same filesystem", () => {
    expect(selectTransferStrategy("relocate", "same-filesystem")).toEqual({
      status: "planned",
      strategy: "same-filesystem-rename",
      steps: ["same-filesystem-rename", "verify-content-identity"],
    });
  });

  it("preserves a source when the intent is copy", () => {
    const decision = selectTransferStrategy("copy", "cross-filesystem");

    expect(decision).toMatchObject({
      status: "planned",
      strategy: "copy-verify-preserve-source",
    });
    if (decision.status === "planned") {
      expect(decision.steps).not.toContain("quarantine-source");
    }
  });

  it("requires review rather than guessing an unknown relocation strategy", () => {
    expect(selectTransferStrategy("relocate", "unknown")).toMatchObject({
      status: "review-required",
    });
  });
});

