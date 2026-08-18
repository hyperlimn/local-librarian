import type {
  InventoryPage,
  InventoryRecord,
  InventoryRecordId,
  InventoryScanId,
  InventorySummary,
  LibraryRootId,
} from "../domain/index.js";
import type {
  InventoryCatalog,
  InventoryListQuery,
} from "../catalog/index.js";
import type { RootEnrollmentStore } from "../enrollment/index.js";
import type { JobClient, JobSubmissionReceipt } from "../jobs/index.js";

export interface InventoryScanSubmissionInput {
  readonly rootId: LibraryRootId;
  readonly idempotencyKey: string;
  readonly requestedBy?: string;
  readonly priority?: number;
  readonly maximumAttempts?: number;
  readonly leaseDurationMilliseconds?: number;
}

export interface McpInventoryTools {
  scan(input: InventoryScanSubmissionInput): Promise<JobSubmissionReceipt>;
  summary(rootId: LibraryRootId): Promise<InventorySummary>;
  list(rootId: LibraryRootId, query?: InventoryListQuery): Promise<InventoryPage>;
  get(recordId: InventoryRecordId): Promise<InventoryRecord | undefined>;
}

/** Submission validates current approval; the worker independently revalidates it. */
export class InventoryTools implements McpInventoryTools {
  public constructor(
    private readonly jobs: JobClient,
    private readonly enrollments: RootEnrollmentStore,
    private readonly catalog: InventoryCatalog,
  ) {}

  public async scan(
    input: InventoryScanSubmissionInput,
  ): Promise<JobSubmissionReceipt> {
    const root = await this.enrollments.get(input.rootId);
    if (root === undefined) throw new Error(`Library root ${input.rootId} is not enrolled.`);
    if (!("controlDirectory" in root.policy)) {
      throw new Error(`Enrolled root ${input.rootId} is not a library root.`);
    }
    if (root.approval.status !== "approved") {
      throw new Error(`Library root ${input.rootId} is not currently approved.`);
    }
    return this.jobs.submit({
      kind: "inventory.scan",
      payload: {
        rootId: root.id,
        rootIdentityKey: root.identity.key,
      },
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy ?? "mcp",
      controlPolicy: {
        pauseMode: "checkpoint",
        cancellationMode: "cooperative",
        maximumAttempts: input.maximumAttempts ?? 3,
        leaseDurationMilliseconds: input.leaseDurationMilliseconds ?? 30_000,
      },
    });
  }

  public summary(rootId: LibraryRootId): Promise<InventorySummary> {
    return this.catalog.summary(rootId);
  }

  public list(
    rootId: LibraryRootId,
    query?: InventoryListQuery,
  ): Promise<InventoryPage> {
    return this.catalog.list(rootId, query);
  }

  public get(recordId: InventoryRecordId): Promise<InventoryRecord | undefined> {
    return this.catalog.get(recordId);
  }
}

export type InventoryScanIdentifier = InventoryScanId;
