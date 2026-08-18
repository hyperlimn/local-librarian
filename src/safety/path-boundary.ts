import * as path from "node:path";

import type {
  ApprovedRootId,
  CanonicalAbsolutePath,
  FilesystemBoundaryRoot,
} from "../domain/index.js";

export type BoundaryPlatform = "win32" | "posix";
export type BoundaryAccess = "read" | "write";

export type BoundaryDenialCode =
  | "root-not-approved"
  | "root-not-absolute"
  | "writes-disabled"
  | "candidate-not-absolute"
  | "outside-approved-root"
  | "invalid-relative-path"
  | "reparse-point-forbidden"
  | "filesystem-boundary-crossing"
  | "canonicalization-failed";

export interface BoundaryDenial {
  readonly allowed: false;
  readonly code: BoundaryDenialCode;
  readonly reason: string;
}

declare const safetyAuthorizationBrand: unique symbol;

/** Opaque capability. Only PathBoundary-issued objects pass the runtime check. */
export interface SafetyAuthorization {
  readonly [safetyAuthorizationBrand]: true;
  readonly rootId: ApprovedRootId;
  readonly canonicalPath: CanonicalAbsolutePath;
  readonly access: BoundaryAccess;
  readonly issuedAt: string;
}

export interface BoundaryAllowance {
  readonly allowed: true;
  readonly authorization: SafetyAuthorization;
}

export type BoundaryDecision = BoundaryAllowance | BoundaryDenial;

export type RelativePathResolution =
  | { readonly resolved: true; readonly absolutePath: string }
  | { readonly resolved: false; readonly reason: string };

const issuedAuthorizations = new WeakSet<object>();

export function isSafetyAuthorization(value: unknown): value is SafetyAuthorization {
  return (
    typeof value === "object" &&
    value !== null &&
    issuedAuthorizations.has(value)
  );
}

export class PathBoundary {
  readonly #paths: path.PlatformPath;

  public constructor(
    platform: BoundaryPlatform,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  /**
   * Lexically resolves untrusted relative input. The result is not yet a
   * canonical path and therefore is deliberately not an authorization.
   */
  public resolveRelativePath(
    root: FilesystemBoundaryRoot,
    untrustedRelativePath: string,
  ): RelativePathResolution {
    if (root.approval.status !== "approved") {
      return { resolved: false, reason: "The filesystem root is not approved." };
    }

    const invalidReason = this.validateRelativeInput(untrustedRelativePath);
    if (invalidReason !== undefined) {
      return { resolved: false, reason: invalidReason };
    }

    const absolutePath = this.#paths.resolve(
      root.canonicalPath,
      untrustedRelativePath,
    );

    if (!this.contains(root.canonicalPath, absolutePath)) {
      return {
        resolved: false,
        reason: "The resolved path is outside the approved filesystem root.",
      };
    }

    return { resolved: true, absolutePath };
  }

  /**
   * Authorizes only a path already canonicalized by CanonicalPathResolver.
   * Canonicalization prevents symlink/junction escapes that lexical checks
   * alone cannot detect.
   */
  public authorizeCanonicalPath(
    root: FilesystemBoundaryRoot,
    candidate: CanonicalAbsolutePath,
    access: BoundaryAccess,
  ): BoundaryDecision {
    if (root.approval.status !== "approved") {
      return {
        allowed: false,
        code: "root-not-approved",
        reason: "The filesystem root is not currently approved.",
      };
    }

    if (!this.#paths.isAbsolute(root.canonicalPath)) {
      return {
        allowed: false,
        code: "root-not-absolute",
        reason: "The approved root must be represented by an absolute path.",
      };
    }

    if (access === "write" && !root.policy.allowWrites) {
      return {
        allowed: false,
        code: "writes-disabled",
        reason: "Writes are disabled by this filesystem root policy.",
      };
    }

    if (!this.#paths.isAbsolute(candidate)) {
      return {
        allowed: false,
        code: "candidate-not-absolute",
        reason: "A safety decision requires a canonical absolute path.",
      };
    }

    if (!this.contains(root.canonicalPath, candidate)) {
      return {
        allowed: false,
        code: "outside-approved-root",
        reason: "The candidate is outside the approved filesystem root.",
      };
    }

    const authorization = Object.freeze({
      rootId: root.id,
      canonicalPath: candidate,
      access,
      issuedAt: this.now(),
    }) as SafetyAuthorization;

    issuedAuthorizations.add(authorization);
    return { allowed: true, authorization };
  }

  private contains(root: string, candidate: string): boolean {
    const relative = this.#paths.relative(
      this.#paths.resolve(root),
      this.#paths.resolve(candidate),
    );

    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${this.#paths.sep}`) &&
        !this.#paths.isAbsolute(relative))
    );
  }

  private validateRelativeInput(value: string): string | undefined {
    if (value.length === 0 || value.includes("\0")) {
      return "A relative path must be non-empty and contain no null bytes.";
    }

    if (this.#paths.isAbsolute(value) || this.#paths.parse(value).root !== "") {
      return "Absolute and drive-qualified inputs are forbidden.";
    }

    const segments = value.split(/[\\/]+/u);
    if (segments.some((segment) => segment === "..")) {
      return "Parent traversal segments are forbidden.";
    }

    if (this.#paths === path.win32) {
      if (value.includes(":")) {
        return "Windows drive and alternate-data-stream syntax is forbidden.";
      }
      if (segments.some((segment) => /[. ]$/u.test(segment))) {
        return "Windows path segments may not end with a dot or space.";
      }
    }

    if (this.#paths.normalize(value) === ".") {
      return "Operations may not target the library root itself.";
    }

    return undefined;
  }
}
