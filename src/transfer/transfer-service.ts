import { randomUUID } from "node:crypto";
import * as path from "node:path";

import type { InventoryCatalog } from "../catalog/index.js";
import type { InventoryRecordId, JsonObject, LibraryRootId } from "../domain/index.js";
import type { RootEnrollmentStore } from "../enrollment/index.js";
import type { JobClient } from "../jobs/index.js";
import type { SqliteIntelligenceStore } from "../intelligence/index.js";
import type { SqliteOrganizationStore } from "../organization/index.js";
import type { DurableTransferPlan, TransferPlanKind } from "./types.js";
import type { SqliteTransferStore } from "./transfer-store.js";

export interface CreateIngestPlanInput {
  readonly sourceRootId: string;
  readonly destinationRootId: LibraryRootId;
  readonly targetDirectory?: string;
  readonly preserveSourceFolders?: boolean;
  readonly retireSource?: boolean;
  readonly requestedBy: string;
}

export interface CreateCrossVolumePlanInput {
  readonly sourceRootId: LibraryRootId;
  readonly destinationRootId: LibraryRootId;
  readonly recordIds: readonly InventoryRecordId[];
  readonly targetDirectory?: string;
  readonly preserveSourceFolders?: boolean;
  readonly requestedBy: string;
}

export class TransferService {
  readonly #paths: path.PlatformPath;

  public constructor(
    private readonly store: SqliteTransferStore,
    private readonly jobs: JobClient,
    private readonly enrollments: RootEnrollmentStore,
    private readonly organization: SqliteOrganizationStore,
    private readonly catalog: InventoryCatalog,
    private readonly intelligence: SqliteIntelligenceStore,
    private readonly clock: () => Date = () => new Date(),
    platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix",
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  public async createIngestPlan(input: CreateIngestPlanInput): Promise<DurableTransferPlan> {
    assertActor(input.requestedBy);
    const [source, destination] = await Promise.all([
      this.enrollments.get(input.sourceRootId as never),
      this.enrollments.get(input.destinationRootId),
    ]);
    if (source === undefined || "controlDirectory" in source.policy || source.approval.status !== "approved") {
      throw new Error("Choose an explicitly approved ingest source.");
    }
    if (
      destination === undefined || !("controlDirectory" in destination.policy) ||
      destination.approval.status !== "approved"
    ) {
      throw new Error("Choose an explicitly approved destination library.");
    }
    if (source.id === destination.id) throw new Error("Source and destination roots must differ.");
    const retireSource = input.retireSource ?? false;
    if (retireSource && (!source.policy.allowWrites || !source.policy.allowSourceRetirement)) {
      throw new Error("Source retirement requires separate write and retirement approval on the ingest source.");
    }
    const now = this.clock().toISOString();
    const id = `ingest-plan-v2:${randomUUID()}`;
    let plan = await this.store.createPlan({
      id,
      kind: "ingest",
      sourceRootId: source.id,
      sourceRootIdentityKey: source.identity.key,
      sourceDisplayPath: source.displayPath,
      destinationRootId: destination.id,
      destinationRootIdentityKey: destination.identity.key,
      targetDirectory: portableTarget(input.targetDirectory ?? "Imported"),
      retireSource,
      preserveSourceFolders: input.preserveSourceFolders ?? true,
      status: "analysis-queued",
      createdBy: input.requestedBy.trim(),
      createdAt: now,
      updatedAt: now,
    });
    try {
      const receipt = await this.jobs.submit({
        kind: "ingest.analyze",
        payload: { planId: id },
        priority: 20,
        idempotencyKey: `ingest-analysis:${id}`,
        requestedBy: input.requestedBy.trim(),
        controlPolicy: {
          pauseMode: "checkpoint",
          cancellationMode: "cooperative",
          maximumAttempts: 3,
          leaseDurationMilliseconds: 30_000,
        },
      });
      plan = await this.store.setPlanState(id, "analysis-queued", now, {
        analysisJobId: receipt.jobId,
      });
      return plan;
    } catch (error) {
      await this.store.setPlanState(id, "failed", this.clock().toISOString(), {
        error: { code: "JOB_SUBMISSION_FAILED", message: errorMessage(error) },
      });
      throw error;
    }
  }

  public async createDuplicateConsolidation(
    duplicateGroupId: string,
    requestedBy: string,
  ): Promise<DurableTransferPlan> {
    assertActor(requestedBy);
    const group = await this.intelligence.duplicateGroup(duplicateGroupId);
    if (group === undefined || group.kind !== "exact" || group.verificationState !== "verified") {
      throw new Error("Only a fully verified exact-duplicate group can be consolidated.");
    }
    const root = await this.enrollments.get(group.rootId as never);
    if (
      root === undefined || !("controlDirectory" in root.policy) ||
      root.approval.status !== "approved"
    ) {
      throw new Error("The duplicate group's library is not currently approved.");
    }
    const now = this.clock().toISOString();
    const id = `duplicate-consolidation-v2:${randomUUID()}`;
    let plan = await this.store.createPlan({
      id,
      kind: "duplicate-consolidation",
      sourceRootId: root.id,
      sourceRootIdentityKey: root.identity.key,
      sourceDisplayPath: root.displayPath,
      retireSource: true,
      preserveSourceFolders: true,
      status: "draft",
      createdBy: requestedBy.trim(),
      createdAt: now,
      updatedAt: now,
    });
    let cursor: string | undefined;
    let added = 0;
    let keeperCount = 0;
    for (;;) {
      const page = await this.intelligence.duplicateMembers(group.id, 500, cursor);
      const candidates = page.items.filter((member) => member.decision === "consolidate");
      keeperCount += page.items.filter((member) => member.decision === "keep" || member.decision === "keep-all").length;
      for (const member of candidates) {
        const hash = await this.intelligence.hashForRecord(member.recordId);
        if (hash === undefined || `sha256:${hash.digestHex}:${hash.byteLength}` !== group.groupKey) {
          throw new Error("A selected duplicate copy no longer has the group's verified content identity.");
        }
        const transferItemId = `transfer-item-v2:${randomUUID()}`;
        await this.store.addDiscoveredItems(id, [{
          id: transferItemId,
          sourceRelativePath: member.relativePath,
          originalSourcePath: this.#paths.join(root.displayPath, member.relativePath),
          originalFileName: member.name,
          byteLength: member.byteLength,
          ...(member.modifiedAt === undefined ? {} : { sourceModifiedAt: member.modifiedAt }),
          ...(hash.observedDeviceId === undefined ? {} : { sourceDeviceId: hash.observedDeviceId }),
          ...(hash.observedFilesystemRecordId === undefined
            ? {}
            : { sourceFilesystemRecordId: hash.observedFilesystemRecordId }),
          algorithm: "sha256",
          digestHex: hash.digestHex,
          category: "Duplicate",
          confidence: 1,
          explanation: "The user selected another verified copy as keeper.",
        }], now);
        await this.store.setItemState(transferItemId, "ready", now);
        added += 1;
      }
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    if (keeperCount === 0 || added === 0) {
      throw new Error("Select at least one keeper and at least one copy to consolidate first.");
    }
    plan = await this.store.setPlanState(id, "ready-for-approval", now);
    return plan;
  }

  public async createCrossVolumePlan(input: CreateCrossVolumePlanInput): Promise<DurableTransferPlan> {
    assertActor(input.requestedBy);
    if (input.recordIds.length === 0 || input.recordIds.length > 10_000) {
      throw new Error("Select between 1 and 10000 files for a cross-volume plan.");
    }
    const [source, destination] = await Promise.all([
      this.enrollments.get(input.sourceRootId),
      this.enrollments.get(input.destinationRootId),
    ]);
    if (
      source === undefined || destination === undefined ||
      !("controlDirectory" in source.policy) || !("controlDirectory" in destination.policy) ||
      source.approval.status !== "approved" || destination.approval.status !== "approved"
    ) {
      throw new Error("Both source and destination libraries must be approved.");
    }
    if (source.identity.volume.key === destination.identity.volume.key) {
      throw new Error("Use the same-filesystem organization planner for roots on the same volume.");
    }
    const target = portableTarget(input.targetDirectory ?? "Organized");
    const now = this.clock().toISOString();
    const id = `cross-volume-plan-v2:${randomUUID()}`;
    let plan = await this.store.createPlan({
      id,
      kind: "cross-volume-organization",
      sourceRootId: source.id,
      sourceRootIdentityKey: source.identity.key,
      sourceDisplayPath: source.displayPath,
      destinationRootId: destination.id,
      destinationRootIdentityKey: destination.identity.key,
      targetDirectory: target,
      retireSource: true,
      preserveSourceFolders: input.preserveSourceFolders ?? true,
      status: "draft",
      createdBy: input.requestedBy.trim(),
      createdAt: now,
      updatedAt: now,
    });
    for (const recordId of new Set(input.recordIds)) {
      const [record, hash] = await Promise.all([
        this.catalog.get(recordId),
        this.intelligence.hashForRecord(recordId),
      ]);
      if (
        record === undefined || record.rootId !== source.id || record.observationStatus !== "observed" ||
        record.entryType !== "file" || hash === undefined
      ) {
        throw new Error("Every cross-volume source must be a currently observed file with verified content identity.");
      }
      const relativeDestination = input.preserveSourceFolders ?? true
        ? `${target}/${record.relativePath}`
        : `${target}/${record.name}`;
      const transferItemId = `transfer-item-v2:${randomUUID()}`;
      await this.store.addDiscoveredItems(id, [{
        id: transferItemId,
        sourceRelativePath: record.relativePath,
        originalSourcePath: this.#paths.join(source.displayPath, record.relativePath),
        originalFileName: record.name,
        destinationRelativePath: portableTarget(relativeDestination),
        byteLength: record.byteLength ?? 0,
        ...(record.modifiedAt === undefined ? {} : { sourceModifiedAt: record.modifiedAt }),
        ...(record.deviceId === undefined ? {} : { sourceDeviceId: record.deviceId }),
        ...(record.filesystemRecordId === undefined ? {} : { sourceFilesystemRecordId: record.filesystemRecordId }),
        algorithm: "sha256",
        digestHex: hash.digestHex,
        confidence: 1,
        explanation: "Verified content identity is available for cross-volume transfer.",
      }], now);
      await this.store.setItemState(transferItemId, "ready", now);
    }
    plan = await this.store.setPlanState(id, "ready-for-approval", now);
    return plan;
  }

  public plan(id: string) { return this.store.plan(id); }
  public plans(query?: Parameters<SqliteTransferStore["plans"]>[0]) { return this.store.plans(query); }
  public items(planId: string, query?: Parameters<SqliteTransferStore["items"]>[1]) {
    return this.store.items(planId, query);
  }
  public quarantine(query?: Parameters<SqliteTransferStore["quarantine"]>[0]) {
    return this.store.quarantine(query);
  }
  public quarantineItem(id: string) { return this.store.quarantineItem(id); }
  public receipt(planId: string) { return this.store.receiptForPlan(planId); }
  public audit(limit?: number, afterSequence?: number) { return this.store.audit(limit, afterSequence); }

  public async resolveItem(
    planId: string,
    itemId: string,
    destinationRelativePath: string,
  ) {
    const item = await this.store.item(itemId);
    if (item === undefined || item.planId !== planId || item.status !== "needs-review") {
      throw new Error("The requested transfer review item is not open on this plan.");
    }
    const saved = await this.store.resolveItem(
      itemId,
      portableTarget(destinationRelativePath),
      this.clock().toISOString(),
    );
    const remaining = await this.store.items(planId, { status: "needs-review", limit: 1 });
    if (remaining.items.length === 0) {
      await this.store.setPlanState(planId, "ready-for-approval", this.clock().toISOString());
    }
    return saved;
  }

  public async approve(planId: string, approvedBy: string, confirmation: string): Promise<DurableTransferPlan> {
    assertActor(approvedBy);
    const plan = await this.store.plan(planId);
    if (plan === undefined || plan.status !== "ready-for-approval") {
      throw new Error("The transfer plan is not ready for approval.");
    }
    if (plan.counts.needsReview > 0 || plan.counts.failed > 0) {
      throw new Error("Resolve every review or failed item before approving this plan.");
    }
    const expected = approvalPhrase(plan.kind, plan.counts.ready, plan.retireSource);
    if (confirmation !== expected) throw new Error(`Type ${expected} to approve this plan.`);
    await this.assertMutationAllowed(plan);
    const now = this.clock().toISOString();
    await this.store.setPlanState(plan.id, "approved", now, {
      approvedBy: approvedBy.trim(),
      approvedAt: now,
    });
    const kind = plan.kind === "duplicate-consolidation"
      ? "quarantine.execute"
      : plan.kind === "ingest" ? "ingest.transfer" : "transfer.execute";
    try {
      const receipt = await this.jobs.submit({
        kind,
        payload: { planId: plan.id },
        priority: 25,
        idempotencyKey: `transfer-execution:${plan.id}`,
        requestedBy: approvedBy.trim(),
        controlPolicy: {
          pauseMode: "checkpoint",
          cancellationMode: "cooperative",
          maximumAttempts: 3,
          leaseDurationMilliseconds: 30_000,
        },
      });
      return this.store.setPlanState(plan.id, "transfer-queued", now, {
        transferJobId: receipt.jobId,
      });
    } catch (error) {
      await this.store.setPlanState(plan.id, "failed", this.clock().toISOString(), {
        error: { code: "JOB_SUBMISSION_FAILED", message: errorMessage(error) },
      });
      throw error;
    }
  }

  public async restore(quarantineId: string, approvedBy: string, confirmation: string) {
    assertActor(approvedBy);
    const item = await this.store.quarantineItem(quarantineId);
    if (item === undefined || !["active", "restore-blocked"].includes(item.status)) {
      throw new Error("Only an active or previously blocked quarantine item can be restored.");
    }
    const expected = `RESTORE ${item.originalFileName}`;
    if (confirmation !== expected) throw new Error(`Type ${expected} to restore this file.`);
    const mode = await this.organization.mutationMode();
    if (mode.mode !== "live") throw new Error("Global file mutation mode is read-only.");
    const root = await this.enrollments.get(item.rootId as never);
    if (root === undefined || root.approval.status !== "approved" || !root.policy.allowWrites) {
      throw new Error("The quarantine root does not have explicit write approval.");
    }
    const receipt = await this.jobs.submit({
      kind: "quarantine.restore",
      payload: { quarantineId },
      priority: 30,
      // A blocked restore can be retried after its collision or availability
      // issue is resolved. The restoring state prevents concurrent submissions.
      idempotencyKey: `quarantine-restore:${quarantineId}:${randomUUID()}`,
      requestedBy: approvedBy.trim(),
      controlPolicy: {
        pauseMode: "not-supported",
        cancellationMode: "cooperative",
        maximumAttempts: 3,
        leaseDurationMilliseconds: 30_000,
      },
    });
    return this.store.setQuarantineState(quarantineId, "restoring", this.clock().toISOString(), {
      restoreJobId: receipt.jobId,
    });
  }

  private async assertMutationAllowed(plan: DurableTransferPlan): Promise<void> {
    const mode = await this.organization.mutationMode();
    if (mode.mode !== "live") throw new Error("Global file mutation mode is read-only.");
    if (plan.destinationRootId !== undefined) {
      const destination = await this.enrollments.get(plan.destinationRootId as never);
      if (destination === undefined || destination.approval.status !== "approved" || !destination.policy.allowWrites) {
        throw new Error("The destination library does not have explicit write approval.");
      }
    }
    if (plan.retireSource) {
      const source = await this.enrollments.get(plan.sourceRootId as never);
      if (source === undefined || source.approval.status !== "approved" || !source.policy.allowWrites) {
        throw new Error("The source root does not have explicit write approval for quarantine.");
      }
      if (
        !("controlDirectory" in source.policy) &&
        (!source.policy.allowSourceRetirement)
      ) {
        throw new Error("Source retirement is not explicitly approved for this ingest source.");
      }
    }
  }
}

function approvalPhrase(kind: TransferPlanKind, count: number, retireSource: boolean): string {
  if (kind === "duplicate-consolidation") return `QUARANTINE ${count} DUPLICATE COPIES`;
  if (kind === "cross-volume-organization") return `TRANSFER ${count} FILES`;
  return retireSource ? `IMPORT ${count} FILES AND QUARANTINE SOURCES` : `IMPORT ${count} FILES`;
}

function portableTarget(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (
    normalized.length === 0 || normalized.includes("\0") || normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === ".." || segment === ".") ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new Error("A safe non-empty relative destination path is required.");
  }
  if (normalized === ".local-librarian" || normalized.startsWith(".local-librarian/")) {
    throw new Error("Transfer destinations cannot use Local Librarian's control directory.");
  }
  return normalized;
}

function assertActor(value: string): void {
  if (value.trim().length === 0) throw new Error("An actor is required.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}
