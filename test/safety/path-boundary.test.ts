import { describe, expect, it } from "vitest";

import type {
  CanonicalAbsolutePath,
  LibraryRoot,
  LibraryRootId,
  RootRelativePath,
} from "../../src/domain/index.js";
import {
  isSafetyAuthorization,
  PathBoundary,
} from "../../src/safety/index.js";

const canonical = (value: string): CanonicalAbsolutePath =>
  value as CanonicalAbsolutePath;

const rootRelative = (value: string): RootRelativePath =>
  value as RootRelativePath;

function approvedWindowsRoot(
  options: { readonly allowWrites?: boolean } = {},
): LibraryRoot {
  return {
    id: "root-1" as LibraryRootId,
    displayName: "Test Library",
    displayPath: "C:\\Library",
    canonicalPath: canonical("C:\\Library"),
    identity: {
      formatVersion: 1,
      key: "filesystem-root-v1:test",
      volume: {
        kind: "filesystem-device",
        key: "filesystem-device:test",
        stability: "best-effort",
        deviceId: "test-device",
        mountPathAtEnrollment: "C:\\",
      },
      relativePathWithinVolume: "Library",
      canonicalPathAtEnrollment: "C:\\Library",
    },
    approval: {
      status: "approved",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test-user",
    },
    policy: {
      allowWrites: options.allowWrites ?? true,
      followSymbolicLinks: false,
      stayOnFileSystem: true,
      controlDirectory: rootRelative(".local-librarian"),
      quarantineDirectory: rootRelative(".local-librarian\\quarantine"),
      ignoredPaths: [rootRelative(".local-librarian")],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("PathBoundary relative resolution", () => {
  it("resolves an ordinary descendant inside an approved root", () => {
    const boundary = new PathBoundary("win32");

    expect(
      boundary.resolveRelativePath(
        approvedWindowsRoot(),
        "photos\\2025\\image.jpg",
      ),
    ).toEqual({
      resolved: true,
      absolutePath: "C:\\Library\\photos\\2025\\image.jpg",
    });
  });

  it.each([
    "..\\outside.txt",
    "folder\\..\\outside.txt",
    "C:\\outside.txt",
    "D:relative-on-drive.txt",
    "file.txt:alternate-stream",
    "folder\\trailing. ",
    "",
    ".",
  ])("rejects unsafe input: %s", (candidate) => {
    const boundary = new PathBoundary("win32");

    expect(
      boundary.resolveRelativePath(approvedWindowsRoot(), candidate).resolved,
    ).toBe(false);
  });

  it("rejects resolution when root approval has been revoked", () => {
    const boundary = new PathBoundary("win32");
    const root: LibraryRoot = {
      ...approvedWindowsRoot(),
      approval: {
        status: "revoked",
        revokedAt: "2026-01-02T00:00:00.000Z",
        reason: "test",
      },
    };

    expect(boundary.resolveRelativePath(root, "photo.jpg").resolved).toBe(false);
  });
});

describe("PathBoundary canonical authorization", () => {
  it("authorizes a canonical descendant and issues a runtime-verifiable token", () => {
    const boundary = new PathBoundary(
      "win32",
      () => "2026-01-03T00:00:00.000Z",
    );
    const decision = boundary.authorizeCanonicalPath(
      approvedWindowsRoot(),
      canonical("C:\\Library\\photos\\image.jpg"),
      "read",
    );

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(isSafetyAuthorization(decision.authorization)).toBe(true);
      expect(decision.authorization.issuedAt).toBe(
        "2026-01-03T00:00:00.000Z",
      );
    }
  });

  it.each([
    "C:\\Library-archive\\file.txt",
    "C:\\Other\\file.txt",
    "D:\\Library\\file.txt",
  ])("rejects canonical paths outside the approved root: %s", (candidate) => {
    const boundary = new PathBoundary("win32");
    const decision = boundary.authorizeCanonicalPath(
      approvedWindowsRoot(),
      canonical(candidate),
      "read",
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "outside-approved-root",
    });
  });

  it("uses Windows case-insensitive containment semantics", () => {
    const boundary = new PathBoundary("win32");
    const decision = boundary.authorizeCanonicalPath(
      approvedWindowsRoot(),
      canonical("c:\\library\\photos\\image.jpg"),
      "read",
    );

    expect(decision.allowed).toBe(true);
  });

  it("rejects writes when the root is read-only", () => {
    const boundary = new PathBoundary("win32");
    const decision = boundary.authorizeCanonicalPath(
      approvedWindowsRoot({ allowWrites: false }),
      canonical("C:\\Library\\photo.jpg"),
      "write",
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "writes-disabled",
    });
  });

  it("does not accept a structurally forged authorization", () => {
    expect(
      isSafetyAuthorization({
        rootId: "root-1",
        canonicalPath: "C:\\Library\\photo.jpg",
        access: "read",
        issuedAt: "2026-01-03T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});
