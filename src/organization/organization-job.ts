import type { BigIntStats } from "node:fs";
import { lstat, mkdir, rename } from "node:fs/promises";
import * as path from "node:path";

import type {
  ApprovedLibraryRoot,
  CanonicalAbsolutePath,
  JsonObject,
  LibraryRootId,
  RootRelativePath,
} from "../domain/index.js";
import type {
  JobDefinition,
  JobExecutionContext,
  JobHandler,
  PersistentJobRecord,
  StructuredJobResult,
} from "../jobs/index.js";
import { JobHandlerFailure } from "../jobs/index.js";
import type { SafetyAuthorization } from "../safety/index.js";
import {
  PathBoundary,
  ReadOnlyCanonicalPathResolver,
  ReadOnlyRootPathResolver,
} from "../safety/index.js";
import {
  InventoryRootGuard,
  InventoryRootValidationError,
} from "../scanner/index.js";
import type {
  OrganizationOperation,
  OrganizationRun,
  OrganizationRunItem,
  OrganizationRunItemOutcome,
  OrganizationRunMode,
} from "./organization.js";
import type { SqliteOrganizationStore } from "./organization-store.js";

export interface OrganizationJobPayload extends JsonObject {
  readonly runId: string;
}

export const ORGANIZATION_EXECUTE_JOB_DEFINITION: JobDefinition = {
  kind: "organization.execute",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validateOrganizationPayload,
};

export const ORGANIZATION_ROLLBACK_JOB_DEFINITION: JobDefinition = {
  kind: "organization.rollback",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validateOrganizationPayload,
};

interface OperationOutcome {
  readonly outcome: OrganizationRunItemOutcome;
  readonly message: string;
}

interface ExistingPath {
  readonly authorization: SafetyAuthorization;
  readonly stats: BigIntStats;
}

/** Executes reviewed relocation plans; it never copies or permanently deletes. */
export class OrganizationExecutionJobHandler implements JobHandler {
  public readonly kind = "organization.execute" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #engine: OrganizationExecutionEngine;

  public constructor(
    rootGuard: InventoryRootGuard,
    store: SqliteOrganizationStore,
    canonicalizer: ReadOnlyCanonicalPathResolver,
    rootResolver: ReadOnlyRootPathResolver,
    boundary: PathBoundary,
    clock: () => Date = () => new Date(),
  ) {
    this.#engine = new OrganizationExecutionEngine(
      rootGuard,
      store,
      canonicalizer,
      rootResolver,
      boundary,
      clock,
    );
  }

  public run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    return this.#engine.run(job, context, "forward");
  }
}

export class OrganizationRollbackJobHandler implements JobHandler {
  public readonly kind = "organization.rollback" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;
  readonly #engine: OrganizationExecutionEngine;

  public constructor(
    rootGuard: InventoryRootGuard,
    store: SqliteOrganizationStore,
    canonicalizer: ReadOnlyCanonicalPathResolver,
    rootResolver: ReadOnlyRootPathResolver,
    boundary: PathBoundary,
    clock: () => Date = () => new Date(),
  ) {
    this.#engine = new OrganizationExecutionEngine(
      rootGuard,
      store,
      canonicalizer,
      rootResolver,
      boundary,
      clock,
    );
  }

  public run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    return this.#engine.run(job, context, "rollback");
  }
}

class OrganizationExecutionEngine {
  readonly #paths: path.PlatformPath;

  public constructor(
    private readonly rootGuard: InventoryRootGuard,
    private readonly store: SqliteOrganizationStore,
    private readonly canonicalizer: ReadOnlyCanonicalPathResolver,
    private readonly rootResolver: ReadOnlyRootPathResolver,
    private readonly boundary: PathBoundary,
    private readonly clock: () => Date,
    platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix",
  ) {
    this.#paths = platform === "win32" ? path.win32 : path.posix;
  }

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
    direction: "forward" | "rollback",
  ): Promise<StructuredJobResult> {
    validateOrganizationPayload(job.payload);
    const runId = job.payload["runId"] as string;
    let run = await this.store.getRun(runId);
    if (run === undefined) {
      throw new JobHandlerFailure("ORGANIZATION_RUN_NOT_FOUND", "The organization run does not exist.", false);
    }
    const expectedDirection = run.mode.startsWith("rollback") ? "rollback" : "forward";
    if (expectedDirection !== direction) {
      throw new JobHandlerFailure("ORGANIZATION_RUN_KIND_MISMATCH", "The run does not match the worker job kind.", false);
    }
    if (run.jobId !== undefined && run.jobId !== job.id) {
      throw new JobHandlerFailure("ORGANIZATION_JOB_BINDING_MISMATCH", "The run is bound to a different job.", false);
    }
    if (["completed", "partial"].includes(run.status)) {
      return resultFor(run, this.#now());
    }
    const plan = await this.store.getPlan(run.planId);
    if (plan === undefined) {
      throw new JobHandlerFailure("ORGANIZATION_PLAN_NOT_FOUND", "The organization plan does not exist.", false);
    }

    try {
      await this.validateRootAndMode(plan.rootId, plan.rootIdentityKey, run.mode);
      run = await this.store.startRun(run.id);
      const operations = await this.store.executableOperations(run);
      for (const operation of operations) {
        const signal = await context.controlSignal();
        if (signal !== "continue") {
          await this.store.setRunStatus(run.id, signal === "pause" ? "paused" : "cancelled");
          await context.saveCheckpoint({
            runId: run.id,
            lastCompletedOrdinal: operation.ordinal - 1,
          });
          await context.throwIfControlRequested();
        }

        const root = await this.validateRootAndMode(
          plan.rootId,
          plan.rootIdentityKey,
          run.mode,
        );
        let outcome: OperationOutcome;
        try {
          outcome = direction === "forward"
            ? await this.forward(root, operation, run.mode, () =>
                this.validateRootAndMode(plan.rootId, plan.rootIdentityKey, run!.mode))
            : await this.rollback(root, operation, run.mode, () =>
                this.validateRootAndMode(plan.rootId, plan.rootIdentityKey, run!.mode));
        } catch (error) {
          if (error instanceof PostRenameVerificationIndeterminateError) throw error;
          outcome = {
            outcome: "failed",
            message: error instanceof Error ? error.message : "The operation failed.",
          };
        }
        const completedAt = this.#now();
        await this.store.recordRunItem({
          runId: run.id,
          operationId: operation.id,
          ...outcome,
          completedAt,
        });
        const current = await this.store.getRun(run.id);
        if (current === undefined) throw new Error("The organization run disappeared.");
        await context.saveCheckpoint({
          runId: run.id,
          lastCompletedOrdinal: operation.ordinal,
        });
        await context.reportProgress({
          phase: direction === "forward" ? "organizing" : "rolling-back",
          completedUnits: current.counts.processed,
          totalUnits: current.counts.total,
          unit: "items",
          percent: current.counts.total === 0
            ? 100
            : Math.round((current.counts.processed / current.counts.total) * 100),
          message: `${direction === "forward" ? "Processed" : "Restored"} ${operation.sourceRelativePath}`,
          metrics: {
            succeeded: current.counts.succeeded,
            skipped: current.counts.skipped,
            failed: current.counts.failed,
            executionMode: run.mode,
          },
          updatedAt: completedAt,
        });
      }
      const completed = await this.store.getRun(run.id);
      if (completed === undefined) throw new Error("The organization run disappeared.");
      const terminal = completed.counts.failed > 0 || completed.counts.skipped > 0
        ? "partial"
        : "completed";
      run = await this.store.setRunStatus(run.id, terminal);
      return resultFor(run, this.#now());
    } catch (error) {
      if (isCooperativeControl(error)) throw error;
      const code = error instanceof OrganizationExecutionError
        ? error.code
        : error instanceof InventoryRootValidationError
          ? error.code
          : error instanceof JobHandlerFailure
            ? error.code
            : "ORGANIZATION_EXECUTION_FAILED";
      await this.store.setRunStatus(run.id, "failed", {
        code,
        message: error instanceof Error ? error.message : "Organization execution failed.",
      });
      if (error instanceof JobHandlerFailure) throw error;
      throw new JobHandlerFailure(
        code,
        error instanceof Error ? error.message : "Organization execution failed.",
        error instanceof PostRenameVerificationIndeterminateError,
        { runId: run.id, planId: run.planId },
      );
    }
  }

  private async forward(
    root: ApprovedLibraryRoot,
    operation: OrganizationOperation,
    mode: OrganizationRunMode,
    recheckGate: () => Promise<ApprovedLibraryRoot>,
  ): Promise<OperationOutcome> {
    return this.relocate(
      root,
      operation.sourceRelativePath,
      operation.destinationRelativePath,
      operation,
      mode === "simulation",
      "moved",
      "already-completed",
      recheckGate,
    );
  }

  private async rollback(
    root: ApprovedLibraryRoot,
    operation: OrganizationOperation,
    mode: OrganizationRunMode,
    recheckGate: () => Promise<ApprovedLibraryRoot>,
  ): Promise<OperationOutcome> {
    return this.relocate(
      root,
      operation.destinationRelativePath,
      operation.sourceRelativePath,
      operation,
      mode === "rollback-simulation",
      "rolled-back",
      "already-rolled-back",
      recheckGate,
    );
  }

  private async relocate(
    root: ApprovedLibraryRoot,
    from: RootRelativePath,
    to: RootRelativePath,
    operation: OrganizationOperation,
    simulation: boolean,
    successOutcome: "moved" | "rolled-back",
    recoveredOutcome: "already-completed" | "already-rolled-back",
    recheckGate: () => Promise<ApprovedLibraryRoot>,
  ): Promise<OperationOutcome> {
    const source = await this.inspectExisting(root, from, simulation ? "read" : "write");
    const destination = await this.inspectOptionalExisting(root, to, simulation ? "read" : "write");

    if (source === undefined) {
      if (destination !== undefined && matchesExpected(destination.stats, operation)) {
        return {
          outcome: recoveredOutcome,
          message: "The filesystem already reflects this operation; recovery recorded it without repeating the move.",
        };
      }
      return { outcome: "failed", message: `Source file is missing: ${from}` };
    }
    if (!source.stats.isFile()) {
      return { outcome: "skipped", message: `Source is no longer a regular file: ${from}` };
    }
    if (!matchesExpected(source.stats, operation)) {
      return {
        outcome: "skipped",
        message: `Source metadata changed after inventory; refusing to move: ${from}`,
      };
    }
    if (destination !== undefined) {
      return { outcome: "skipped", message: `Destination already exists: ${to}` };
    }

    const prospective = await this.resolveProspective(root, to, simulation ? "read" : "write");
    if (simulation) {
      return {
        outcome: successOutcome === "moved" ? "simulated" : "would-rollback",
        message: `${successOutcome === "moved" ? "Would move" : "Would restore"} ${from} to ${to}.`,
      };
    }

    await this.ensureParentDirectories(root, to);
    const freshSource = await this.inspectExisting(root, from, "write");
    const freshDestination = await this.inspectOptionalExisting(root, to, "write");
    if (freshSource === undefined || !matchesExpected(freshSource.stats, operation)) {
      return { outcome: "skipped", message: "The source changed during final safety validation." };
    }
    if (freshDestination !== undefined) {
      return { outcome: "skipped", message: "The destination appeared during final safety validation." };
    }
    await recheckGate();
    const finalDestination = await this.resolveProspective(root, to, "write");
    await rename(freshSource.authorization.canonicalPath, finalDestination.canonicalPath);
    let verified: ExistingPath | undefined;
    try {
      verified = await this.inspectExisting(root, to, "read");
    } catch (error) {
      throw new PostRenameVerificationIndeterminateError(
        `The rename completed, but destination verification could not finish at ${to}: ${
          error instanceof Error ? error.message : "unknown verification error"
        }. The durable job will retry and reconcile the filesystem state.`,
      );
    }
    if (verified === undefined || !matchesExpected(verified.stats, operation)) {
      throw new PostRenameVerificationIndeterminateError(
        `The rename completed, but the relocated file could not yet be verified at ${to}. ` +
        "The durable job will retry without repeating a completed rename.",
      );
    }
    return {
      outcome: successOutcome,
      message: `${successOutcome === "moved" ? "Moved" : "Restored"} ${from} to ${to}.`,
    };
  }

  private async validateRootAndMode(
    rootId: LibraryRootId,
    identityKey: string,
    mode: OrganizationRunMode,
  ): Promise<ApprovedLibraryRoot> {
    const root = await this.rootGuard.validateForScan(rootId, identityKey);
    if (!isLiveMode(mode)) return root;
    const state = await this.store.mutationMode();
    if (state.mode !== "live") {
      throw new OrganizationExecutionError(
        "FILE_MUTATION_DISABLED",
        "File mutation mode is read-only. The live run stopped before another move.",
      );
    }
    if (!root.policy.allowWrites) {
      throw new OrganizationExecutionError(
        "LIBRARY_WRITES_DISABLED",
        "This library does not have explicit write approval.",
      );
    }
    return root;
  }

  private async inspectExisting(
    root: ApprovedLibraryRoot,
    relativePath: RootRelativePath,
    access: "read" | "write",
  ): Promise<ExistingPath | undefined> {
    const decision = await this.rootResolver.resolveExisting(root, relativePath);
    if (!decision.allowed) {
      if (decision.code === "canonicalization-failed" && /does not exist/iu.test(decision.reason)) {
        return undefined;
      }
      throw new OrganizationExecutionError("PATH_BOUNDARY_DENIED", decision.reason);
    }
    const authorization = access === "read"
      ? decision.authorization
      : this.requireAuthorization(
          this.boundary.authorizeCanonicalPath(root, decision.authorization.canonicalPath, "write"),
        );
    try {
      const stats = await lstat(authorization.canonicalPath, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw new OrganizationExecutionError("REPARSE_POINT_FORBIDDEN", "Symbolic links and junctions cannot be mutated.");
      }
      return { authorization, stats };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private inspectOptionalExisting(
    root: ApprovedLibraryRoot,
    relativePath: RootRelativePath,
    access: "read" | "write",
  ): Promise<ExistingPath | undefined> {
    return this.inspectExisting(root, relativePath, access);
  }

  private async resolveProspective(
    root: ApprovedLibraryRoot,
    relativePath: RootRelativePath,
    access: "read" | "write",
  ): Promise<SafetyAuthorization> {
    const lexical = this.boundary.resolveRelativePath(root, relativePath);
    if (!lexical.resolved) {
      throw new OrganizationExecutionError("INVALID_RELATIVE_PATH", lexical.reason);
    }
    const canonicalPath = await this.canonicalizer.canonicalizeProspective(lexical.absolutePath);
    const ancestorPath = await nearestExistingAncestor(lexical.absolutePath, this.#paths);
    const ancestor = await this.canonicalizer.inspectExisting(ancestorPath);
    if (ancestor.reparsePoints.length > 0) {
      throw new OrganizationExecutionError(
        "REPARSE_POINT_FORBIDDEN",
        "The destination ancestor traverses a symlink, junction, or reparse point.",
      );
    }
    if (ancestor.entryKind !== "directory") {
      throw new OrganizationExecutionError("DESTINATION_PARENT_INVALID", "The destination ancestor is not a directory.");
    }
    if (ancestor.deviceId !== root.identity.volume.deviceId) {
      throw new OrganizationExecutionError("FILESYSTEM_BOUNDARY_CROSSING", "The destination crosses a filesystem boundary.");
    }
    return this.requireAuthorization(
      this.boundary.authorizeCanonicalPath(root, canonicalPath, access),
    );
  }

  private async ensureParentDirectories(
    root: ApprovedLibraryRoot,
    destination: RootRelativePath,
  ): Promise<void> {
    const segments = destination.replaceAll("\\", "/").split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      const relative = current as RootRelativePath;
      const existing = await this.inspectExisting(root, relative, "write");
      if (existing !== undefined) {
        if (!existing.stats.isDirectory()) {
          throw new OrganizationExecutionError(
            "DESTINATION_PARENT_INVALID",
            `A destination parent is not a directory: ${relative}`,
          );
        }
        continue;
      }
      const target = await this.resolveProspective(root, relative, "write");
      try {
        await mkdir(target.canonicalPath);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      const created = await this.inspectExisting(root, relative, "write");
      if (created === undefined || !created.stats.isDirectory()) {
        throw new OrganizationExecutionError(
          "DIRECTORY_CREATION_FAILED",
          `A safe destination directory could not be created: ${relative}`,
        );
      }
    }
  }

  private requireAuthorization(
    decision: ReturnType<PathBoundary["authorizeCanonicalPath"]>,
  ): SafetyAuthorization {
    if (!decision.allowed) {
      throw new OrganizationExecutionError("PATH_BOUNDARY_DENIED", decision.reason);
    }
    return decision.authorization;
  }

  #now(): string {
    return this.clock().toISOString();
  }
}

export class OrganizationExecutionError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OrganizationExecutionError";
  }
}

class PostRenameVerificationIndeterminateError extends OrganizationExecutionError {
  public constructor(message: string) {
    super("POST_MOVE_VERIFICATION_INDETERMINATE", message);
    this.name = "PostRenameVerificationIndeterminateError";
  }
}

function validateOrganizationPayload(payload: JsonObject): void {
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "runId" || typeof payload["runId"] !== "string") {
    throw new Error("Organization job payload must contain only a non-empty runId string.");
  }
  if (payload["runId"].length === 0) {
    throw new Error("Organization runId must not be empty.");
  }
}

function matchesExpected(stats: BigIntStats, operation: OrganizationOperation): boolean {
  if (!stats.isFile()) return false;
  if (Number(stats.size) !== operation.expected.byteLength) return false;
  if (
    operation.expected.deviceId !== undefined &&
    stats.dev.toString() !== operation.expected.deviceId
  ) return false;
  if (
    operation.expected.filesystemRecordId !== undefined &&
    stats.ino.toString() !== operation.expected.filesystemRecordId
  ) return false;
  if (
    operation.expected.modifiedAt !== undefined &&
    new Date(Number(stats.mtimeMs)).toISOString() !== operation.expected.modifiedAt
  ) return false;
  return true;
}

async function nearestExistingAncestor(
  inputPath: string,
  paths: path.PlatformPath,
): Promise<string> {
  let candidate = inputPath;
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = paths.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isLiveMode(mode: OrganizationRunMode): boolean {
  return mode === "live" || mode === "rollback-live";
}

function resultFor(run: OrganizationRun, completedAt: string): StructuredJobResult {
  return {
    summary: {
      runId: run.id,
      planId: run.planId,
      mode: run.mode,
      status: run.status,
      total: run.counts.total,
      processed: run.counts.processed,
      succeeded: run.counts.succeeded,
      skipped: run.counts.skipped,
      failed: run.counts.failed,
    },
    artifacts: [{ kind: "other", id: run.id, mediaType: "application/json" }],
    completedAt,
  };
}

function isCooperativeControl(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "JobPauseRequested" || error.name === "JobCancellationRequested");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
