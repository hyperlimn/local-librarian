import { describe, expect, it } from "vitest";

import {
  assertJobTransition,
  canTransitionJob,
  InvalidJobTransitionError,
} from "../../src/jobs/index.js";

describe("job lifecycle", () => {
  it("supports checkpoint pause and queued resume", () => {
    expect(canTransitionJob("running", "paused")).toBe(true);
    expect(canTransitionJob("paused", "queued")).toBe(true);
    expect(canTransitionJob("queued", "running")).toBe(true);
  });

  it("supports crash recovery and retry by requeueing", () => {
    expect(canTransitionJob("running", "queued")).toBe(true);
    expect(canTransitionJob("failed", "queued")).toBe(true);
  });

  it("keeps completed and cancelled jobs terminal", () => {
    expect(canTransitionJob("completed", "running")).toBe(false);
    expect(canTransitionJob("cancelled", "queued")).toBe(false);
    expect(() => assertJobTransition("completed", "queued")).toThrow(
      InvalidJobTransitionError,
    );
  });
});

