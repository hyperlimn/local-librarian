import { open, readFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

import type {
  ApprovedLibraryRoot,
  LibraryRoot,
} from "../domain/index.js";
import type {
  ApprovedIngestSource,
  IngestSource,
} from "../ingest/index.js";
import type {
  EnrolledRootId,
  EnrolledRootListQuery,
  RootEnrollmentRole,
} from "./enrollment.js";

export type EnrolledRoot = LibraryRoot | IngestSource;
export type ApprovedEnrolledRoot = ApprovedLibraryRoot | ApprovedIngestSource;

type RootEnrollmentEvent =
  | {
      readonly formatVersion: 1;
      readonly event: "root-approved";
      readonly role: RootEnrollmentRole;
      readonly root: EnrolledRoot;
      readonly occurredAt: string;
    }
  | {
      readonly formatVersion: 1;
      readonly event: "root-revoked";
      readonly rootId: EnrolledRootId;
      readonly reason: string;
      readonly occurredAt: string;
    };

export interface RootEnrollmentStore {
  saveApproved(root: ApprovedEnrolledRoot): Promise<void>;
  get(id: EnrolledRootId): Promise<EnrolledRoot | undefined>;
  list(query?: EnrolledRootListQuery): Promise<readonly EnrolledRoot[]>;
  revoke(
    id: EnrolledRootId,
    reason: string,
    revokedAt: string,
  ): Promise<EnrolledRoot>;
}

export class EnrollmentStoreCorruptionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EnrollmentStoreCorruptionError";
  }
}

/** Metadata-only, append-only JSONL persistence in an app-owned state path. */
export class JsonlRootEnrollmentStore implements RootEnrollmentStore {
  public constructor(private readonly storePath: string) {}

  public async saveApproved(root: ApprovedEnrolledRoot): Promise<void> {
    await this.append({
      formatVersion: 1,
      event: "root-approved",
      role: isLibraryRoot(root) ? "library" : "ingest-source",
      root,
      occurredAt:
        root.approval.status === "approved"
          ? root.approval.approvedAt
          : new Date().toISOString(),
    });
  }

  public async get(id: EnrolledRootId): Promise<EnrolledRoot | undefined> {
    const roots = await this.replay();
    return roots.get(id);
  }

  public async list(
    query: EnrolledRootListQuery = {},
  ): Promise<readonly EnrolledRoot[]> {
    const roots = [...(await this.replay()).values()];
    return roots
      .filter(
        (root) =>
          query.includeRevoked === true || root.approval.status === "approved",
      )
      .filter(
        (root) =>
          query.role === undefined ||
          query.role === (isLibraryRoot(root) ? "library" : "ingest-source"),
      )
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  public async revoke(
    id: EnrolledRootId,
    reason: string,
    revokedAt: string,
  ): Promise<EnrolledRoot> {
    const existing = await this.get(id);
    if (existing === undefined) {
      throw new Error(`Cannot revoke an unknown root: ${id}`);
    }
    await this.append({
      formatVersion: 1,
      event: "root-revoked",
      rootId: id,
      reason,
      occurredAt: revokedAt,
    });
    return {
      ...existing,
      approval: { status: "revoked", revokedAt, reason },
    };
  }

  private async replay(): Promise<Map<EnrolledRootId, EnrolledRoot>> {
    const events = await this.readEvents();
    const roots = new Map<EnrolledRootId, EnrolledRoot>();
    for (const event of events) {
      if (event.event === "root-approved") {
        roots.set(event.root.id, event.root);
        continue;
      }
      const existing = roots.get(event.rootId);
      if (existing !== undefined) {
        roots.set(event.rootId, {
          ...existing,
          approval: {
            status: "revoked",
            revokedAt: event.occurredAt,
            reason: event.reason,
          },
        });
      }
    }
    return roots;
  }

  private async readEvents(): Promise<readonly RootEnrollmentEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.storePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    if (contents.length === 0) {
      return [];
    }
    if (!contents.endsWith("\n")) {
      throw new EnrollmentStoreCorruptionError(
        "The enrollment journal ends with an incomplete JSONL record.",
      );
    }

    return contents
      .trimEnd()
      .split("\n")
      .map((line, index) => {
        try {
          return JSON.parse(line) as RootEnrollmentEvent;
        } catch (error) {
          throw new EnrollmentStoreCorruptionError(
            `Invalid enrollment JSONL at line ${index + 1}: ${String(error)}`,
          );
        }
      });
  }

  private async append(event: RootEnrollmentEvent): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const handle = await open(this.storePath, "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function isLibraryRoot(root: EnrolledRoot): root is LibraryRoot {
  return "controlDirectory" in root.policy;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
