import { describe, expect, it } from "vitest";

import type {
  InventoryRecord,
  InventoryScanId,
  LibraryRootId,
  RootRelativePath,
} from "../../src/domain/index.js";
import {
  reconcile,
  ReconciliationRootMismatchError,
} from "../../src/reconciliation/index.js";

const rootId = "root-1" as LibraryRootId;
const baselineScanId = "scan-baseline" as InventoryScanId;
const comparisonScanId = "scan-comparison" as InventoryScanId;

function record(
  overrides: Omit<Partial<InventoryRecord>, "relativePath"> & { relativePath: string },
): InventoryRecord {
  return {
    id: `record:${overrides.relativePath}` as InventoryRecord["id"],
    scanId: baselineScanId,
    rootId,
    jobId: "job-1" as InventoryRecord["jobId"],
    name: overrides.relativePath.split("/").pop() ?? overrides.relativePath,
    entryType: "file",
    observationStatus: "observed",
    byteLength: 100,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    attributes: {},
    contentIdentity: { status: "not-requested" },
    observedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    relativePath: overrides.relativePath as RootRelativePath,
  };
}

describe("reconcile", () => {
  it("reports no deltas when both scans are identical", () => {
    const before = record({ relativePath: "notes.txt" });
    const report = reconcile({
      rootId,
      baselineScanId,
      comparisonScanId,
      baselineRecords: [before],
      comparisonRecords: [record({ relativePath: "notes.txt" })],
      now: () => "2026-02-01T00:00:00.000Z",
    });

    expect(report.deltas).toEqual([]);
    expect(report.generatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("reports a path present only in the comparison scan as added", () => {
    const report = reconcile({
      rootId,
      baselineScanId,
      comparisonScanId,
      baselineRecords: [],
      comparisonRecords: [record({ relativePath: "new-file.txt" })],
    });

    expect(report.deltas).toEqual([
      expect.objectContaining({ relativePath: "new-file.txt", kind: "added" }),
    ]);
  });

  it("reports a path present only in the baseline scan as missing", () => {
    const report = reconcile({
      rootId,
      baselineScanId,
      comparisonScanId,
      baselineRecords: [record({ relativePath: "deleted-file.txt" })],
      comparisonRecords: [],
    });

    expect(report.deltas).toEqual([
      expect.objectContaining({ relativePath: "deleted-file.txt", kind: "missing" }),
    ]);
  });

  it("reports metadata-changed with the specific changed fields when byte length differs", () => {
    const report = reconcile({
      rootId,
      baselineScanId,
      comparisonScanId,
      baselineRecords: [record({ relativePath: "notes.txt", byteLength: 100 })],
      comparisonRecords: [record({ relativePath: "notes.txt", byteLength: 250 })],
    });

    expect(report.deltas).toEqual([
      expect.objectContaining({
        relativePath: "notes.txt",
        kind: "metadata-changed",
        changedFields: ["byteLength"],
      }),
    ]);
  });

  it("does not treat differing scanId, jobId, or observedAt as a change", () => {
    const before = record({
      relativePath: "notes.txt",
      scanId: baselineScanId,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    const after = record({
      relativePath: "notes.txt",
      scanId: comparisonScanId,
      observedAt: "2026-06-01T00:00:00.000Z",
    });

    const report = reconcile({
      rootId,
      baselineScanId,
      comparisonScanId,
      baselineRecords: [before],
      comparisonRecords: [after],
    });

    expect(report.deltas).toEqual([]);
  });

  it("ignores skipped and error observations on both sides", () => {
    const report = reconcile({
      rootId,
      baselineScanId,
      comparisonScanId,
      baselineRecords: [
        record({ relativePath: "unreadable.txt", observationStatus: "error" }),
      ],
      comparisonRecords: [
        record({ relativePath: "unreadable.txt", observationStatus: "skipped" }),
      ],
    });

    expect(report.deltas).toEqual([]);
  });

  it("throws when a record belongs to a different root than requested", () => {
    const foreignRecord = record({
      relativePath: "notes.txt",
      rootId: "root-2" as LibraryRootId,
    });

    expect(() =>
      reconcile({
        rootId,
        baselineScanId,
        comparisonScanId,
        baselineRecords: [foreignRecord],
        comparisonRecords: [],
      }),
    ).toThrow(ReconciliationRootMismatchError);
  });

  it("sorts deltas by relative path for stable output", () => {
    const report = reconcile({
      rootId,
      baselineScanId,
      comparisonScanId,
      baselineRecords: [],
      comparisonRecords: [
        record({ relativePath: "zebra.txt" }),
        record({ relativePath: "apple.txt" }),
      ],
    });

    expect(report.deltas.map((delta) => delta.relativePath)).toEqual([
      "apple.txt",
      "zebra.txt",
    ]);
  });
});