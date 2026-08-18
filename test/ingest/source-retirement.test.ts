import { describe, expect, it } from "vitest";

import type {
  CanonicalAbsolutePath,
  IngestSourceId,
  RootRelativePath,
} from "../../src/domain/index.js";
import type { IngestSource } from "../../src/ingest/index.js";
import { evaluateSourceRetirement } from "../../src/ingest/index.js";

function source(
  allowWrites: boolean,
  allowSourceRetirement: boolean,
): IngestSource {
  return {
    id: "ingest-source-1" as IngestSourceId,
    kind: "sd-card",
    displayName: "Test card",
    displayPath: "E:\\",
    canonicalPath: "E:\\" as CanonicalAbsolutePath,
    identity: {
      formatVersion: 1,
      key: "filesystem-root-v1:test",
      volume: {
        kind: "filesystem-device",
        key: "filesystem-device:test",
        stability: "best-effort",
        deviceId: "test-device",
        mountPathAtEnrollment: "E:\\",
      },
      relativePathWithinVolume: ".",
      canonicalPathAtEnrollment: "E:\\",
    },
    approval: {
      status: "approved",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test-user",
    },
    policy: {
      allowWrites,
      allowSourceRetirement,
      followSymbolicLinks: false,
      stayOnFileSystem: true,
      ignoredPaths: [] as readonly RootRelativePath[],
      removableMedia: true,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("evaluateSourceRetirement", () => {
  it("requires both write and source-retirement approval", () => {
    expect(evaluateSourceRetirement(source(false, true)).allowed).toBe(false);
    expect(evaluateSourceRetirement(source(true, false)).allowed).toBe(false);
    expect(evaluateSourceRetirement(source(true, true)).allowed).toBe(true);
  });

  it("rejects a revoked source regardless of policy", () => {
    const revoked = {
      ...source(true, true),
      approval: {
        status: "revoked",
        revokedAt: "2026-01-02T00:00:00.000Z",
        reason: "removed media",
      },
    } as IngestSource;

    expect(evaluateSourceRetirement(revoked).allowed).toBe(false);
  });
});
