import type {
  ApprovedRootId,
  CanonicalAbsolutePath,
  LibraryRootId,
  RootRelativePath,
} from "./ids.js";
import type { FilesystemRootIdentity } from "./filesystem-identity.js";

export type FilesystemRootApproval =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "approved";
      readonly approvedAt: string;
      readonly approvedBy: string;
    }
  | {
      readonly status: "revoked";
      readonly revokedAt: string;
      readonly reason: string;
    };

export interface RootBoundaryPolicy {
  /** Writes require both this flag and a fresh safety authorization. */
  readonly allowWrites: boolean;
  /** Symlinks are not traversed until a canonicalizing scanner is implemented. */
  readonly followSymbolicLinks: false;
  /** Prevent a scan from silently crossing mounted filesystem boundaries. */
  readonly stayOnFileSystem: boolean;
  readonly ignoredPaths: readonly RootRelativePath[];
}

export interface FilesystemBoundaryRoot {
  readonly id: ApprovedRootId;
  /** User-facing path as entered at enrollment; may change with drive mounts. */
  readonly displayPath: string;
  readonly canonicalPath: CanonicalAbsolutePath;
  readonly identity: FilesystemRootIdentity;
  readonly approval: FilesystemRootApproval;
  readonly policy: RootBoundaryPolicy;
}

export type LibraryRootApproval = FilesystemRootApproval;
export type ApprovedFilesystemRootApproval = Extract<
  FilesystemRootApproval,
  { readonly status: "approved" }
>;

export interface LibraryRootPolicy extends RootBoundaryPolicy {
  /** App-owned metadata location, relative to this approved root. */
  readonly controlDirectory: RootRelativePath;
  /** Future recoverable removals are relocated here, never permanently deleted. */
  readonly quarantineDirectory: RootRelativePath;
}

export interface LibraryRoot extends FilesystemBoundaryRoot {
  readonly id: LibraryRootId;
  readonly displayName: string;
  readonly displayPath: string;
  /** Resolved canonical path captured during root enrollment. */
  readonly canonicalPath: CanonicalAbsolutePath;
  readonly identity: FilesystemRootIdentity;
  readonly approval: LibraryRootApproval;
  readonly policy: LibraryRootPolicy;
  readonly createdAt: string;
}

export type ApprovedLibraryRoot = LibraryRoot & {
  readonly approval: ApprovedFilesystemRootApproval;
};
