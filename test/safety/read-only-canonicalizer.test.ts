import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ApprovedLibraryRoot,
  LibraryRootId,
  RootRelativePath,
} from "../../src/domain/index.js";
import {
  createFilesystemRootIdentity,
} from "../../src/enrollment/index.js";
import {
  CanonicalPathError,
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
} from "../../src/safety/index.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ReadOnlyCanonicalPathResolver", () => {
  it("canonicalizes and identifies an existing test directory", async () => {
    const selected = await createTemporaryDirectory();
    const resolver = new ReadOnlyCanonicalPathResolver();

    const inspection = await resolver.inspectExisting(selected);

    expect(inspection.entryKind).toBe("directory");
    expect(inspection.canonicalPath).toBe(await resolver.canonicalizeExisting(selected));
    expect(inspection.deviceId.length).toBeGreaterThan(0);
    expect(inspection.reparsePoints).toEqual([]);
  });

  it("rejects relative paths and parent traversal before filesystem access", async () => {
    const resolver = new ReadOnlyCanonicalPathResolver();
    const traversal =
      process.platform === "win32"
        ? "C:\\safe\\..\\outside"
        : "/safe/../outside";

    await expect(resolver.canonicalizeExisting("relative/path")).rejects.toMatchObject({
      code: "path-not-absolute",
    } satisfies Partial<CanonicalPathError>);
    await expect(resolver.canonicalizeExisting(traversal)).rejects.toMatchObject({
      code: "parent-traversal",
    } satisfies Partial<CanonicalPathError>);
  });

  it.runIf(process.platform === "win32")(
    "rejects drive-relative, device namespace, and alternate-stream paths",
    async () => {
      const resolver = new ReadOnlyCanonicalPathResolver();

      await expect(resolver.canonicalizeExisting("D:relative")).rejects.toMatchObject({
        code: "drive-relative-path",
      });
      await expect(
        resolver.canonicalizeExisting("\\\\?\\C:\\unsafe"),
      ).rejects.toMatchObject({ code: "device-namespace-path" });
      await expect(
        resolver.canonicalizeExisting("C:\\safe\\file.txt:stream"),
      ).rejects.toMatchObject({ code: "alternate-data-stream" });
    },
  );
});

describe("ReadOnlyRootPathResolver", () => {
  it("rejects a symlink or junction escape from an enrolled root", async () => {
    const parent = await createTemporaryDirectory();
    const rootPath = path.join(parent, "root");
    const outsidePath = path.join(parent, "outside");
    await mkdir(rootPath);
    await mkdir(outsidePath);
    await writeFile(path.join(outsidePath, "secret.txt"), "test-only", "utf8");

    const linkPath = path.join(rootPath, "escape");
    try {
      await symlink(
        outsidePath,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (isPermissionError(error)) {
        return;
      }
      throw error;
    }

    const canonicalizer = new ReadOnlyCanonicalPathResolver();
    const inspection = await canonicalizer.inspectExisting(rootPath);
    const root = approvedRoot(inspection);
    const resolver = new ReadOnlyRootPathResolver(
      canonicalizer,
      new PathBoundary(process.platform === "win32" ? "win32" : "posix"),
    );

    await expect(
      resolver.resolveExisting(root, path.join("escape", "secret.txt")),
    ).resolves.toMatchObject({
      allowed: false,
      code: "reparse-point-forbidden",
    });
  });

  it("rejects an unexpected filesystem-device mismatch", async () => {
    const rootPath = await createTemporaryDirectory();
    await writeFile(path.join(rootPath, "file.txt"), "test-only", "utf8");
    const canonicalizer = new ReadOnlyCanonicalPathResolver();
    const inspection = await canonicalizer.inspectExisting(rootPath);
    const root = approvedRoot(inspection, "different-device");
    const resolver = new ReadOnlyRootPathResolver(
      canonicalizer,
      new PathBoundary(process.platform === "win32" ? "win32" : "posix"),
    );

    await expect(resolver.resolveExisting(root, "file.txt")).resolves.toMatchObject({
      allowed: false,
      code: "filesystem-boundary-crossing",
    });
  });
});

function approvedRoot(
  inspection: Awaited<
    ReturnType<ReadOnlyCanonicalPathResolver["inspectExisting"]>
  >,
  deviceId = inspection.deviceId,
): ApprovedLibraryRoot {
  const volume = {
    kind: "filesystem-device" as const,
    key: `filesystem-device:${deviceId}`,
    stability: "best-effort" as const,
    deviceId,
    mountPathAtEnrollment: inspection.mountPath,
  };
  return {
    id: "test-root" as LibraryRootId,
    displayName: "Test root",
    displayPath: inspection.requestedPath,
    canonicalPath: inspection.canonicalPath,
    identity: createFilesystemRootIdentity(inspection, volume),
    approval: {
      status: "approved",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test-user",
    },
    policy: {
      allowWrites: false,
      followSymbolicLinks: false,
      stayOnFileSystem: true,
      controlDirectory: ".local-librarian" as RootRelativePath,
      quarantineDirectory:
        ".local-librarian/quarantine" as RootRelativePath,
      ignoredPaths: [".local-librarian" as RootRelativePath],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EPERM" ||
      (error as NodeJS.ErrnoException).code === "EACCES")
  );
}

