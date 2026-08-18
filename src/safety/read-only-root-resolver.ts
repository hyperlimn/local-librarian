import type { FilesystemBoundaryRoot } from "../domain/index.js";
import type { BoundaryDecision } from "./path-boundary.js";
import { PathBoundary } from "./path-boundary.js";
import {
  CanonicalPathError,
  ReadOnlyCanonicalPathResolver,
} from "./read-only-canonicalizer.js";

/** Combines lexical containment, realpath resolution, and volume checks. */
export class ReadOnlyRootPathResolver {
  public constructor(
    private readonly canonicalizer: ReadOnlyCanonicalPathResolver,
    private readonly boundary: PathBoundary,
  ) {}

  public async resolveExisting(
    root: FilesystemBoundaryRoot,
    untrustedRelativePath: string,
  ): Promise<BoundaryDecision> {
    const lexical = this.boundary.resolveRelativePath(
      root,
      untrustedRelativePath,
    );
    if (!lexical.resolved) {
      return {
        allowed: false,
        code: "invalid-relative-path",
        reason: lexical.reason,
      };
    }

    try {
      const inspection = await this.canonicalizer.inspectExisting(
        lexical.absolutePath,
      );
      if (inspection.reparsePoints.length > 0) {
        return {
          allowed: false,
          code: "reparse-point-forbidden",
          reason: "The path traverses a symlink, junction, or reparse point.",
        };
      }
      if (inspection.deviceId !== root.identity.volume.deviceId) {
        return {
          allowed: false,
          code: "filesystem-boundary-crossing",
          reason: "The path crossed onto a different filesystem volume.",
        };
      }
      return this.boundary.authorizeCanonicalPath(
        root,
        inspection.canonicalPath,
        "read",
      );
    } catch (error) {
      return {
        allowed: false,
        code: "canonicalization-failed",
        reason:
          error instanceof CanonicalPathError
            ? error.message
            : "Canonical path inspection failed.",
      };
    }
  }
}

