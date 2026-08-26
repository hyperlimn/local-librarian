import { createHash, randomUUID } from "node:crypto";

import type { InventoryCatalog } from "../catalog/index.js";
import type {
  InventoryRecord,
  InventoryScanId,
  LibraryRoot,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";
import type { RootEnrollmentStore } from "../enrollment/index.js";
import { PathBoundary } from "../safety/index.js";
import { categorizeInventoryFile } from "./categorizer.js";
import type {
  OrganizationCollisionPolicy,
  OrganizationOperation,
  OrganizationPlan,
  OrganizationPlanOptions,
  OrganizationScope,
  OrganizationStrategy,
} from "./organization.js";
import type { SqliteOrganizationStore } from "./organization-store.js";
import type {
  OrganizationPlanningEvidence,
  SqliteIntelligenceStore,
} from "../intelligence/index.js";

export interface CreateOrganizationPlanInput {
  readonly rootId: LibraryRootId;
  readonly strategy?: OrganizationStrategy;
  readonly philosophy?: import("./organization.js").OrganizationPhilosophy;
  readonly scope?: OrganizationScope;
  readonly targetDirectory?: string;
  readonly collisionPolicy?: OrganizationCollisionPolicy;
  readonly includeHidden?: boolean;
  readonly maximumOperations?: number;
  readonly createdBy: string;
}

export class OrganizationPlanningError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OrganizationPlanningError";
  }
}

/** Builds a deterministic, reviewable plan from one immutable completed scan. */
export class OrganizationPlannerService {
  readonly #boundary: PathBoundary;

  public constructor(
    private readonly catalog: InventoryCatalog,
    private readonly enrollments: RootEnrollmentStore,
    private readonly store: SqliteOrganizationStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly platform: "win32" | "posix" =
      process.platform === "win32" ? "win32" : "posix",
    private readonly intelligence?: SqliteIntelligenceStore,
  ) {
    this.#boundary = new PathBoundary(platform);
  }

  public async createPlan(input: CreateOrganizationPlanInput): Promise<OrganizationPlan> {
    const root = await this.loadApprovedLibrary(input.rootId);
    const summary = await this.catalog.summary(input.rootId);
    const scan = summary.latestScan;
    if (scan === undefined) {
      throw new OrganizationPlanningError(
        "INVENTORY_REQUIRED",
        "Run an inventory scan before creating an organization plan.",
      );
    }
    if (scan.status !== "completed") {
      throw new OrganizationPlanningError(
        "COMPLETED_INVENTORY_REQUIRED",
        "The latest inventory scan must finish before a plan can be created.",
      );
    }
    if (scan.rootIdentityKey !== root.identity.key) {
      throw new OrganizationPlanningError(
        "ROOT_IDENTITY_MISMATCH",
        "The latest scan belongs to an older filesystem-root identity.",
      );
    }

    const options = this.validateOptions(root, input);
    const planId = `organization-plan-v1:${randomUUID()}`;
    const operations: OrganizationOperation[] = [];
    const plannedDestinations = new Set<string>();
    const byCategory: Record<string, number> = {};
    let scannedFiles = 0;
    let eligibleFiles = 0;
    let representedBytes = 0;
    let preservedByScope = 0;
    let alreadyOrganized = 0;
    let hiddenExcluded = 0;
    let conflictsSkipped = 0;
    let limitedOut = 0;
    let preservedCoherentGroups = 0;
    let needsReviewExcluded = 0;

    let cursor: string | undefined;
    for (;;) {
      const page = await this.catalog.list(input.rootId, {
        scanId: scan.id,
        limit: 1_000,
        ...(cursor === undefined ? {} : { cursor }),
        entryType: "file",
      });
      const planningEvidence = this.intelligence === undefined
        ? new Map<string, OrganizationPlanningEvidence>()
        : await this.intelligence.organizationPlanningEvidence(page.items.map((record) => record.id));
      for (const record of page.items) {
        if (record.observationStatus !== "observed") continue;
        scannedFiles += 1;
        if (record.attributes.hidden === true && !options.includeHidden) {
          hiddenExcluded += 1;
          continue;
        }
        if (isWithin(record.relativePath, root.policy.controlDirectory, this.platform)) {
          alreadyOrganized += 1;
          continue;
        }
        if (isWithin(record.relativePath, options.targetDirectory, this.platform)) {
          alreadyOrganized += 1;
          continue;
        }
        const evidence = planningEvidence.get(record.id);
        if ((options.scope === "top-level" || options.philosophy === "conservative") && hasParent(record.relativePath)) {
          preservedByScope += 1;
          continue;
        }
        if ((evidence?.semanticGroups.length ?? 0) > 0) {
          preservedCoherentGroups += 1;
          continue;
        }
        if (evidence?.uncertainty === "needs-review") {
          needsReviewExcluded += 1;
          continue;
        }

        eligibleFiles += 1;
        if (operations.length >= options.maximumOperations) {
          limitedOut += 1;
          continue;
        }
        const category = evidence?.category ?? categorizeInventoryFile(record);
        const desired = destinationFor(record, category, options, evidence?.captureAt);
        const destination = await this.availableDestination(
          input.rootId,
          scan.id,
          desired,
          options.collisionPolicy,
          plannedDestinations,
        );
        if (destination === undefined) {
          conflictsSkipped += 1;
          continue;
        }
        if (pathKey(destination, this.platform) === pathKey(record.relativePath, this.platform)) {
          alreadyOrganized += 1;
          continue;
        }
        const ordinal = operations.length;
        const operation: OrganizationOperation = {
          id: organizationOperationId(planId, ordinal, record.relativePath, destination),
          planId,
          ordinal,
          sourceRelativePath: record.relativePath,
          destinationRelativePath: destination,
          category,
          rationale: rationaleFor(category, record, options, evidence),
          expected: {
            byteLength: record.byteLength ?? 0,
            ...(record.modifiedAt === undefined ? {} : { modifiedAt: record.modifiedAt }),
            ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
            ...(record.filesystemRecordId === undefined
              ? {}
              : { filesystemRecordId: record.filesystemRecordId }),
          },
        };
        operations.push(operation);
        plannedDestinations.add(pathKey(destination, this.platform));
        representedBytes += operation.expected.byteLength;
        byCategory[category] = (byCategory[category] ?? 0) + 1;
      }
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }

    const plan: OrganizationPlan = {
      id: planId,
      rootId: input.rootId,
      rootIdentityKey: root.identity.key,
      scanId: scan.id,
      status: "ready",
      options,
      counts: {
        scannedFiles,
        eligibleFiles,
        plannedMoves: operations.length,
        representedBytes,
        preservedByScope,
        alreadyOrganized,
        hiddenExcluded,
        conflictsSkipped,
        limitedOut,
        preservedCoherentGroups,
        needsReviewExcluded,
        byCategory,
      },
      createdAt: this.clock().toISOString(),
      createdBy: input.createdBy.trim(),
    };
    await this.store.createPlan(plan, operations);
    return plan;
  }

  public async assertPlanFresh(plan: OrganizationPlan): Promise<void> {
    const [root, summary] = await Promise.all([
      this.loadApprovedLibrary(plan.rootId),
      this.catalog.summary(plan.rootId),
    ]);
    if (root.identity.key !== plan.rootIdentityKey) {
      throw new OrganizationPlanningError(
        "STALE_PLAN",
        "The library identity changed after this plan was created. Build a new plan.",
      );
    }
    if (summary.latestScan?.id !== plan.scanId || summary.latestScan.status !== "completed") {
      throw new OrganizationPlanningError(
        "STALE_PLAN",
        "A newer inventory exists or is in progress. Build a fresh organization plan before execution.",
      );
    }
  }

  private validateOptions(
    root: LibraryRoot,
    input: CreateOrganizationPlanInput,
  ): OrganizationPlanOptions {
    if (input.createdBy.trim().length === 0) {
      throw new OrganizationPlanningError("ACTOR_REQUIRED", "A planning actor is required.");
    }
    const strategy = input.strategy ?? "category-and-year";
    if (!["category", "category-and-year", "year-and-month"].includes(strategy)) {
      throw new OrganizationPlanningError("INVALID_STRATEGY", "Unknown organization strategy.");
    }
    const philosophy = input.philosophy ?? "balanced";
    if (!["conservative", "balanced", "deep"].includes(philosophy)) {
      throw new OrganizationPlanningError("INVALID_PHILOSOPHY", "Unknown organization philosophy.");
    }
    const scope = input.scope ?? (philosophy === "deep" ? "all-files" : "top-level");
    if (!["top-level", "all-files"].includes(scope)) {
      throw new OrganizationPlanningError("INVALID_SCOPE", "Unknown organization scope.");
    }
    const collisionPolicy = input.collisionPolicy ?? "rename-with-suffix";
    if (!["skip", "rename-with-suffix"].includes(collisionPolicy)) {
      throw new OrganizationPlanningError("INVALID_COLLISION_POLICY", "Unknown collision policy.");
    }
    const maximumOperations = Math.trunc(input.maximumOperations ?? 10_000);
    if (maximumOperations < 1 || maximumOperations > 50_000) {
      throw new OrganizationPlanningError(
        "INVALID_MAXIMUM",
        "maximumOperations must be between 1 and 50000.",
      );
    }
    const target = portablePath(input.targetDirectory ?? "Organized");
    const decision = this.#boundary.resolveRelativePath(root, target);
    if (!decision.resolved) {
      throw new OrganizationPlanningError("INVALID_TARGET", decision.reason);
    }
    if (
      isWithin(target, root.policy.controlDirectory, this.platform) ||
      isWithin(root.policy.controlDirectory, target, this.platform) ||
      isWithin(target, root.policy.quarantineDirectory, this.platform) ||
      isWithin(root.policy.quarantineDirectory, target, this.platform)
    ) {
      throw new OrganizationPlanningError(
        "RESERVED_TARGET",
        "The organization target may not overlap Local Librarian's control or quarantine directory.",
      );
    }
    return {
      strategy,
      philosophy,
      scope,
      targetDirectory: target,
      collisionPolicy,
      includeHidden: input.includeHidden ?? false,
      maximumOperations,
    };
  }

  private async availableDestination(
    rootId: LibraryRootId,
    scanId: InventoryScanId,
    desired: RootRelativePath,
    collisionPolicy: OrganizationCollisionPolicy,
    planned: ReadonlySet<string>,
  ): Promise<RootRelativePath | undefined> {
    if (await this.isAvailable(rootId, scanId, desired, planned)) return desired;
    if (collisionPolicy === "skip") return undefined;
    const { stem, extension } = splitFilename(desired);
    for (let suffix = 2; suffix <= 10_000; suffix += 1) {
      const candidate = `${stem} (${suffix})${extension}` as RootRelativePath;
      if (await this.isAvailable(rootId, scanId, candidate, planned)) return candidate;
    }
    return undefined;
  }

  private async isAvailable(
    rootId: LibraryRootId,
    scanId: InventoryScanId,
    candidate: RootRelativePath,
    planned: ReadonlySet<string>,
  ): Promise<boolean> {
    return (
      !planned.has(pathKey(candidate, this.platform)) &&
      !(await this.catalog.hasObservedPath(rootId, scanId, candidate))
    );
  }

  private async loadApprovedLibrary(rootId: LibraryRootId): Promise<LibraryRoot> {
    const root = await this.enrollments.get(rootId);
    if (root === undefined || !("controlDirectory" in root.policy)) {
      throw new OrganizationPlanningError("ROOT_NOT_ENROLLED", "The library root is not enrolled.");
    }
    const library = root as LibraryRoot;
    if (library.approval.status !== "approved") {
      throw new OrganizationPlanningError("ROOT_NOT_APPROVED", "The library root is not approved.");
    }
    return library;
  }
}

function destinationFor(
  record: InventoryRecord,
  category: string,
  options: OrganizationPlanOptions,
  captureAt?: string,
): RootRelativePath {
  const date = usableDate(captureAt) ?? usableDate(record.modifiedAt) ?? usableDate(record.createdAt);
  const year = date?.slice(0, 4) ?? "Unknown year";
  const month = date?.slice(5, 7) ?? "Unknown month";
  const segments = options.strategy === "category"
    ? [options.targetDirectory, category, record.name]
    : options.strategy === "category-and-year"
      ? [options.targetDirectory, category, year, record.name]
      : [options.targetDirectory, year, month, record.name];
  return segments.join("/") as RootRelativePath;
}

function rationaleFor(
  category: string,
  record: InventoryRecord,
  options: OrganizationPlanOptions,
  evidence?: OrganizationPlanningEvidence,
): string {
  const extension = record.extension?.toLocaleLowerCase("en-US") ?? "no extension";
  if (options.strategy === "category") {
    return evidence?.explanation === undefined
      ? `${extension} files are grouped in ${category}.`
      : `${evidence.explanation} The ${options.philosophy} plan groups it in ${category}.`;
  }
  if (options.strategy === "category-and-year") {
    return `${evidence?.explanation ?? `${extension} files are classified as ${category}.`} ` +
      "The destination uses capture date when available, then observed filesystem dates.";
  }
  return "Files are grouped by observed year and month.";
}

function portablePath(value: string): RootRelativePath {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (trimmed.length === 0 || trimmed.split("/").some((segment) => segment.length === 0)) {
    throw new OrganizationPlanningError("INVALID_TARGET", "A non-empty relative target directory is required.");
  }
  return trimmed as RootRelativePath;
}

function isWithin(
  candidate: string,
  parent: string,
  platform: "win32" | "posix",
): boolean {
  const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  const left = pathKey(normalize(candidate), platform);
  const right = pathKey(normalize(parent), platform);
  return left === right || left.startsWith(`${right}/`);
}

function hasParent(relativePath: string): boolean {
  return relativePath.replaceAll("\\", "/").includes("/");
}

function usableDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function splitFilename(relativePath: RootRelativePath): {
  readonly stem: string;
  readonly extension: string;
} {
  const slash = relativePath.lastIndexOf("/");
  const dot = relativePath.lastIndexOf(".");
  if (dot <= slash) return { stem: relativePath, extension: "" };
  return { stem: relativePath.slice(0, dot), extension: relativePath.slice(dot) };
}

function pathKey(value: string, platform: "win32" | "posix"): string {
  const normalized = value.replaceAll("\\", "/");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function organizationOperationId(
  planId: string,
  ordinal: number,
  source: string,
  destination: string,
): string {
  const digest = createHash("sha256")
    .update("local-librarian-organization-operation-v1\0", "utf8")
    .update(planId, "utf8")
    .update("\0", "utf8")
    .update(String(ordinal), "utf8")
    .update("\0", "utf8")
    .update(source, "utf8")
    .update("\0", "utf8")
    .update(destination, "utf8")
    .digest("hex");
  return `organization-operation-v1:${digest}`;
}
