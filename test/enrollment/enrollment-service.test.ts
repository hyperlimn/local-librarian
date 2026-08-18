import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FilesystemVolumeIdentity } from "../../src/domain/index.js";
import {
  createFilesystemRootIdentity,
  JsonlRootEnrollmentStore,
  RootEnrollmentService,
  SystemVolumeIdentityProvider,
  type VolumeIdentityProvider,
} from "../../src/enrollment/index.js";
import {
  ReadOnlyCanonicalPathResolver,
  type CanonicalPathInspection,
} from "../../src/safety/index.js";

const temporaryDirectories: string[] = [];

async function createFixture(): Promise<{
  readonly selectedPath: string;
  readonly storePath: string;
}> {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "local-librarian-enrollment-test-"),
  );
  temporaryDirectories.push(temporary);
  const selectedPath = path.join(temporary, "selected");
  await mkdir(selectedPath);
  return {
    selectedPath,
    storePath: path.join(temporary, "state", "enrollments.jsonl"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("RootEnrollmentService", () => {
  it("requires proposal approval, persists it, lists it, and revokes it", async () => {
    const fixture = await createFixture();
    const service = createService(fixture.storePath);

    const proposal = await service.propose({
      role: "library",
      path: fixture.selectedPath,
      displayName: "Photos",
    });

    expect(proposal.approvalRequired).toBe(true);
    expect(await service.list()).toEqual([]);

    const approved = await service.approve(proposal.proposalId, "test-user");
    expect(approved.approval.status).toBe("approved");
    expect(approved.policy.allowWrites).toBe(false);

    const reloaded = createService(fixture.storePath);
    expect(await reloaded.list()).toHaveLength(1);

    const revoked = await reloaded.revoke(approved.id, "test revocation");
    expect(revoked.approval.status).toBe("revoked");
    expect(await reloaded.list()).toEqual([]);
    expect(await reloaded.list({ includeRevoked: true })).toMatchObject([
      { approval: { status: "revoked", reason: "test revocation" } },
    ]);
  });

  it("keeps library and ingest roles separate and read-only", async () => {
    const fixture = await createFixture();
    const service = createService(fixture.storePath);
    const libraryProposal = await service.propose({
      role: "library",
      path: fixture.selectedPath,
      displayName: "Library",
    });
    const ingestProposal = await service.propose({
      role: "ingest-source",
      ingestSourceKind: "sd-card",
      path: fixture.selectedPath,
      displayName: "Camera card",
    });

    const library = await service.approve(
      libraryProposal.proposalId,
      "test-user",
    );
    const ingest = await service.approve(
      ingestProposal.proposalId,
      "test-user",
    );

    expect(library.id).not.toBe(ingest.id);
    expect(ingest.policy.allowWrites).toBe(false);
    expect("allowSourceRetirement" in ingest.policy).toBe(true);
    if ("allowSourceRetirement" in ingest.policy) {
      expect(ingest.policy.allowSourceRetirement).toBe(false);
    }
    expect(await service.list({ role: "library" })).toHaveLength(1);
    expect(await service.list({ role: "ingest-source" })).toHaveLength(1);
  });

  it("derives the same root identity after a Windows drive-letter change", () => {
    const volume: FilesystemVolumeIdentity = {
      kind: "windows-volume-guid",
      key: "windows-volume-guid:volume-test",
      stability: "stable",
      deviceId: "device-test",
      volumeGuid: "volume-test",
      mountPathAtEnrollment: "D:\\",
    };
    const onDriveD = createFilesystemRootIdentity(
      inspection("D:\\Photos", "D:\\"),
      volume,
      "win32",
    );
    const onDriveE = createFilesystemRootIdentity(
      inspection("E:\\Photos", "E:\\"),
      { ...volume, mountPathAtEnrollment: "E:\\" },
      "win32",
    );

    expect(onDriveD.key).toBe(onDriveE.key);
    expect(onDriveD.canonicalPathAtEnrollment).not.toBe(
      onDriveE.canonicalPathAtEnrollment,
    );
  });

  it("rejects enrollment through a symlink or junction", async () => {
    const fixture = await createFixture();
    const linkPath = path.join(path.dirname(fixture.selectedPath), "selected-link");
    try {
      await symlink(
        fixture.selectedPath,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (isPermissionError(error)) {
        return;
      }
      throw error;
    }

    await expect(
      createService(fixture.storePath).propose({
        role: "library",
        path: linkPath,
        displayName: "Linked root",
      }),
    ).rejects.toThrow("reparse point");
  });

  it.runIf(process.platform === "win32")(
    "captures the selected Windows volume GUID when mountvol provides it",
    async () => {
      const fixture = await createFixture();
      const canonicalizer = new ReadOnlyCanonicalPathResolver();
      const inspected = await canonicalizer.inspectExisting(fixture.selectedPath);
      const volume = await new SystemVolumeIdentityProvider().identify(inspected);

      expect(volume.kind).toBe("windows-volume-guid");
      expect(volume.stability).toBe("stable");
      expect(volume.volumeGuid).toMatch(/^\\\\\?\\Volume\{/u);
      expect(volume.key).not.toContain(path.parse(fixture.selectedPath).root);
    },
  );
});

function createService(storePath: string): RootEnrollmentService {
  return new RootEnrollmentService(
    new ReadOnlyCanonicalPathResolver(),
    new TestVolumeIdentityProvider(),
    new JsonlRootEnrollmentStore(storePath),
    () => "2026-01-01T00:00:00.000Z",
  );
}

class TestVolumeIdentityProvider implements VolumeIdentityProvider {
  public identify(
    value: CanonicalPathInspection,
  ): Promise<FilesystemVolumeIdentity> {
    return Promise.resolve({
      kind: "filesystem-device",
      key: `test-volume:${value.deviceId}`,
      stability: "best-effort",
      deviceId: value.deviceId,
      mountPathAtEnrollment: value.mountPath,
    });
  }
}

function inspection(
  canonicalPath: string,
  mountPath: string,
): CanonicalPathInspection {
  return {
    requestedPath: canonicalPath,
    canonicalPath: canonicalPath as CanonicalPathInspection["canonicalPath"],
    entryKind: "directory",
    deviceId: "device-test",
    mountPath,
    reparsePoints: [],
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
