import {
  lstat,
  realpath,
  stat,
  statfs,
} from "node:fs/promises";
import * as path from "node:path";

import type { CanonicalAbsolutePath } from "../domain/index.js";
import type { CanonicalPathResolver } from "./canonical-path-resolver.js";

export type CanonicalPathErrorCode =
  | "empty-path"
  | "null-byte"
  | "path-not-absolute"
  | "drive-relative-path"
  | "device-namespace-path"
  | "parent-traversal"
  | "alternate-data-stream"
  | "path-not-found"
  | "path-not-directory"
  | "filesystem-error";

export class CanonicalPathError extends Error {
  public constructor(
    public readonly code: CanonicalPathErrorCode,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = "CanonicalPathError";
  }
}

export interface CanonicalPathInspection {
  readonly requestedPath: string;
  readonly canonicalPath: CanonicalAbsolutePath;
  readonly entryKind: "directory" | "file" | "other";
  readonly deviceId: string;
  readonly fileSystemTypeCode?: string;
  readonly mountPath: string;
  /** Original path components that are symlinks or Windows junctions. */
  readonly reparsePoints: readonly string[];
}

export interface ReadOnlyCanonicalizerOptions {
  readonly platform?: "win32" | "posix";
}

/** Real filesystem canonicalization using metadata reads only. */
export class ReadOnlyCanonicalPathResolver implements CanonicalPathResolver {
  readonly #paths: path.PlatformPath;
  readonly #platform: "win32" | "posix";

  public constructor(options: ReadOnlyCanonicalizerOptions = {}) {
    this.#platform =
      options.platform ?? (process.platform === "win32" ? "win32" : "posix");
    this.#paths = this.#platform === "win32" ? path.win32 : path.posix;
  }

  public async canonicalizeExisting(
    inputPath: string,
  ): Promise<CanonicalAbsolutePath> {
    this.validateInput(inputPath);
    try {
      return (await realpath(inputPath)) as CanonicalAbsolutePath;
    } catch (error) {
      throw this.mapFilesystemError(inputPath, error);
    }
  }

  public async canonicalizeProspective(
    inputPath: string,
  ): Promise<CanonicalAbsolutePath> {
    this.validateInput(inputPath);

    const missingSegments: string[] = [];
    let existingAncestor = this.#paths.normalize(inputPath);

    while (true) {
      try {
        await lstat(existingAncestor);
        break;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw this.mapFilesystemError(existingAncestor, error);
        }
        const parent = this.#paths.dirname(existingAncestor);
        if (parent === existingAncestor) {
          throw new CanonicalPathError(
            "path-not-found",
            `No existing ancestor could be found for: ${inputPath}`,
            error,
          );
        }
        missingSegments.unshift(this.#paths.basename(existingAncestor));
        existingAncestor = parent;
      }
    }

    const canonicalAncestor = await this.canonicalizeExisting(existingAncestor);
    return this.#paths.resolve(
      canonicalAncestor,
      ...missingSegments,
    ) as CanonicalAbsolutePath;
  }

  public async inspectExisting(
    inputPath: string,
  ): Promise<CanonicalPathInspection> {
    this.validateInput(inputPath);

    try {
      const reparsePoints = await this.findReparsePoints(inputPath);
      const canonicalPath = await this.canonicalizeExisting(inputPath);
      const entryStats = await stat(canonicalPath, { bigint: true });
      const fileSystemTypeCode = await this.readFileSystemType(canonicalPath);
      const mountPath = await this.findMountPath(
        canonicalPath,
        entryStats.dev.toString(),
      );

      return {
        requestedPath: inputPath,
        canonicalPath,
        entryKind: entryStats.isDirectory()
          ? "directory"
          : entryStats.isFile()
            ? "file"
            : "other",
        deviceId: entryStats.dev.toString(),
        ...(fileSystemTypeCode === undefined ? {} : { fileSystemTypeCode }),
        mountPath,
        reparsePoints,
      };
    } catch (error) {
      if (error instanceof CanonicalPathError) {
        throw error;
      }
      throw this.mapFilesystemError(inputPath, error);
    }
  }

  public assertDirectory(inspection: CanonicalPathInspection): void {
    if (inspection.entryKind !== "directory") {
      throw new CanonicalPathError(
        "path-not-directory",
        `An enrolled root must be a directory: ${inspection.requestedPath}`,
      );
    }
  }

  private validateInput(inputPath: string): void {
    if (inputPath.length === 0) {
      throw new CanonicalPathError("empty-path", "A path is required.");
    }
    if (inputPath.includes("\0")) {
      throw new CanonicalPathError("null-byte", "Null bytes are forbidden.");
    }

    if (
      this.#platform === "win32" &&
      (inputPath.startsWith("\\\\?\\") || inputPath.startsWith("\\\\.\\"))
    ) {
      throw new CanonicalPathError(
        "device-namespace-path",
        "Windows device-namespace paths are not accepted as user input.",
      );
    }

    const parsed = this.#paths.parse(inputPath);
    if (this.#platform === "win32" && /^[A-Za-z]:$/u.test(parsed.root)) {
      throw new CanonicalPathError(
        "drive-relative-path",
        "Drive-relative paths such as D:folder are forbidden.",
      );
    }
    if (!this.#paths.isAbsolute(inputPath)) {
      throw new CanonicalPathError(
        "path-not-absolute",
        "Enrollment and canonicalization require an absolute path.",
      );
    }

    const pathWithoutRoot = inputPath.slice(parsed.root.length);
    const segments = pathWithoutRoot.split(/[\\/]+/u);
    if (segments.some((segment) => segment === "..")) {
      throw new CanonicalPathError(
        "parent-traversal",
        "Parent traversal segments are forbidden.",
      );
    }
    if (
      this.#platform === "win32" &&
      segments.some((segment) => segment.includes(":"))
    ) {
      throw new CanonicalPathError(
        "alternate-data-stream",
        "Windows alternate data stream syntax is forbidden.",
      );
    }
  }

  private async findReparsePoints(inputPath: string): Promise<readonly string[]> {
    const normalized = this.#paths.normalize(inputPath);
    const parsed = this.#paths.parse(normalized);
    const segments = normalized
      .slice(parsed.root.length)
      .split(/[\\/]+/u)
      .filter((segment) => segment.length > 0);

    const found: string[] = [];
    let current = parsed.root;
    for (const segment of segments) {
      current = this.#paths.join(current, segment);
      const componentStats = await lstat(current, { bigint: true });
      if (componentStats.isSymbolicLink()) {
        found.push(current);
      }
    }
    return found;
  }

  private async findMountPath(
    canonicalPath: string,
    deviceId: string,
  ): Promise<string> {
    let current = canonicalPath;
    let mountPath = canonicalPath;

    while (true) {
      const parent = this.#paths.dirname(current);
      if (parent === current) {
        return mountPath;
      }
      const parentStats = await stat(parent, { bigint: true });
      if (parentStats.dev.toString() !== deviceId) {
        return mountPath;
      }
      mountPath = parent;
      current = parent;
    }
  }

  private async readFileSystemType(
    canonicalPath: string,
  ): Promise<string | undefined> {
    try {
      const fileSystemStats = await statfs(canonicalPath, { bigint: true });
      return `0x${fileSystemStats.type.toString(16)}`;
    } catch {
      return undefined;
    }
  }

  private mapFilesystemError(inputPath: string, error: unknown): CanonicalPathError {
    if (isNodeError(error, "ENOENT")) {
      return new CanonicalPathError(
        "path-not-found",
        `The path does not exist: ${inputPath}`,
        error,
      );
    }
    return new CanonicalPathError(
      "filesystem-error",
      `Unable to inspect path: ${inputPath}`,
      error,
    );
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
