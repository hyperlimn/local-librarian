/** Identity of the volume underneath an enrolled path. */
export interface FilesystemVolumeIdentity {
  readonly kind: "windows-volume-guid" | "filesystem-device";
  /** Does not include the current drive letter or mount path. */
  readonly key: string;
  readonly stability: "stable" | "best-effort";
  readonly deviceId: string;
  readonly fileSystemTypeCode?: string;
  readonly fileSystemTypeName?: string;
  readonly volumeGuid?: string;
  /** Human-facing mount path at inspection time; not part of durable identity. */
  readonly mountPathAtEnrollment: string;
}

/**
 * Durable root identity combines a volume identity with a normalized path
 * inside that volume. `key` is a versioned SHA-256 digest of those two values.
 */
export interface FilesystemRootIdentity {
  readonly formatVersion: 1;
  readonly key: string;
  readonly volume: FilesystemVolumeIdentity;
  readonly relativePathWithinVolume: string;
  readonly canonicalPathAtEnrollment: string;
}

