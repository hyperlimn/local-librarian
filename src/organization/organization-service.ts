import { randomUUID } from "node:crypto";

import type { JobClient } from "../jobs/index.js";
import type { RootEnrollmentStore } from "../enrollment/index.js";
import type {
  FileMutationMode,
  OrganizationRun,
  OrganizationRunMode,
} from "./organization.js";
import type {
  CreateOrganizationPlanInput,
  OrganizationPlannerService,
} from "./organization-planner.js";
import type { SqliteOrganizationStore } from "./organization-store.js";

export interface StartOrganizationRunInput {
  readonly planId: string;
  readonly mode: "simulation" | "live";
  readonly approvedBy: string;
  readonly confirmation: string;
}

export interface StartOrganizationRollbackInput {
  readonly sourceRunId: string;
  readonly mode: "simulation" | "live";
  readonly approvedBy: string;
  readonly confirmation: string;
}

export class OrganizationService {
  public constructor(
    private readonly planner: OrganizationPlannerService,
    private readonly store: SqliteOrganizationStore,
    private readonly jobs: JobClient,
    private readonly enrollments: RootEnrollmentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public createPlan(input: CreateOrganizationPlanInput) {
    return this.planner.createPlan(input);
  }

  public getPlan(id: string) {
    return this.store.getPlan(id);
  }

  public listPlans(rootId?: CreateOrganizationPlanInput["rootId"], limit?: number, cursor?: string) {
    return this.store.listPlans({
      ...(rootId === undefined ? {} : { rootId }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  public listOperations(planId: string, limit?: number, cursor?: string) {
    return this.store.listOperations(planId, limit, cursor);
  }

  public getRun(id: string) {
    return this.store.getRun(id);
  }

  public listRuns(planId?: string, limit?: number, cursor?: string) {
    return this.store.listRuns({
      ...(planId === undefined ? {} : { planId }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  public listRunItems(runId: string, limit?: number, cursor?: string) {
    return this.store.listRunItems(runId, limit, cursor);
  }

  public mutationMode() {
    return this.store.mutationMode();
  }

  public async setMutationMode(
    mode: FileMutationMode,
    updatedBy: string,
    confirmation: string,
  ) {
    if (updatedBy.trim().length === 0) throw new Error("A safety actor is required.");
    if (mode === "live" && confirmation !== "ENABLE LIVE FILE MUTATION") {
      throw new Error("Type ENABLE LIVE FILE MUTATION to enable live mode.");
    }
    if (mode === "read-only" && confirmation !== "DISABLE") {
      throw new Error("Type DISABLE to return to read-only mode.");
    }
    return this.store.setMutationMode(mode, updatedBy.trim());
  }

  public audit(limit?: number, cursor?: string) {
    return this.store.audit(limit, cursor);
  }

  public verifyAuditIntegrity() {
    return this.store.verifyAuditIntegrity();
  }

  public async startRun(input: StartOrganizationRunInput): Promise<OrganizationRun> {
    const plan = await this.store.getPlan(input.planId);
    if (plan === undefined) throw new Error("The organization plan does not exist.");
    await this.planner.assertPlanFresh(plan);
    this.assertActor(input.approvedBy);
    if (input.mode === "simulation") {
      if (input.confirmation !== "SIMULATE") {
        throw new Error("Confirm SIMULATE to test this plan without file mutation.");
      }
    } else {
      if (input.confirmation !== `APPLY ${plan.counts.plannedMoves} FILE MOVES`) {
        throw new Error(`Type APPLY ${plan.counts.plannedMoves} FILE MOVES to apply this plan.`);
      }
      await this.assertLiveAllowed(plan.rootId);
    }
    return this.submitRun({
      planId: plan.id,
      mode: input.mode,
      approvedBy: input.approvedBy.trim(),
    });
  }

  public async startRollback(
    input: StartOrganizationRollbackInput,
  ): Promise<OrganizationRun> {
    const sourceRun = await this.store.getRun(input.sourceRunId);
    if (sourceRun === undefined || sourceRun.mode !== "live") {
      throw new Error("Rollback requires an existing live organization run.");
    }
    if (!["completed", "partial"].includes(sourceRun.status)) {
      throw new Error("Only a completed or partial live run can be rolled back.");
    }
    if (sourceRun.counts.succeeded === 0) {
      throw new Error("The live run has no successful moves to roll back.");
    }
    const plan = await this.store.getPlan(sourceRun.planId);
    if (plan === undefined) throw new Error("The source plan does not exist.");
    this.assertActor(input.approvedBy);
    if (input.mode === "simulation") {
      if (input.confirmation !== "SIMULATE ROLLBACK") {
        throw new Error("Confirm SIMULATE ROLLBACK to test restoration.");
      }
    } else {
      if (input.confirmation !== `ROLL BACK ${sourceRun.counts.succeeded} FILE MOVES`) {
        throw new Error(
          `Type ROLL BACK ${sourceRun.counts.succeeded} FILE MOVES to restore these files.`,
        );
      }
      await this.assertLiveAllowed(plan.rootId);
    }
    return this.submitRun({
      planId: plan.id,
      sourceRunId: sourceRun.id,
      mode: input.mode === "live" ? "rollback-live" : "rollback-simulation",
      approvedBy: input.approvedBy.trim(),
    });
  }

  private async submitRun(input: {
    readonly planId: string;
    readonly sourceRunId?: string;
    readonly mode: OrganizationRunMode;
    readonly approvedBy: string;
  }): Promise<OrganizationRun> {
    const runId = `organization-run-v1:${randomUUID()}`;
    let run = await this.store.createRun({
      run: {
        id: runId,
        planId: input.planId,
        ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
        mode: input.mode,
        status: "queued",
        approvedBy: input.approvedBy,
        createdAt: this.clock().toISOString(),
      },
    });
    try {
      const receipt = await this.jobs.submit({
        kind: input.mode.startsWith("rollback")
          ? "organization.rollback"
          : "organization.execute",
        payload: { runId },
        priority: 25,
        idempotencyKey: `organization:${runId}`,
        requestedBy: input.approvedBy,
        controlPolicy: {
          pauseMode: "checkpoint",
          cancellationMode: "cooperative",
          maximumAttempts: 3,
          leaseDurationMilliseconds: 30_000,
        },
      });
      run = await this.store.attachRunJob(runId, receipt.jobId, input.approvedBy);
      return run;
    } catch (error) {
      await this.store.setRunStatus(runId, "failed", {
        code: "JOB_SUBMISSION_FAILED",
        message: error instanceof Error ? error.message : "Job submission failed.",
        actor: input.approvedBy,
      });
      throw error;
    }
  }

  private async assertLiveAllowed(rootId: CreateOrganizationPlanInput["rootId"]): Promise<void> {
    const mode = await this.store.mutationMode();
    if (mode.mode !== "live") {
      throw new Error("Global file mutation mode is read-only.");
    }
    const root = await this.enrollments.get(rootId);
    if (
      root === undefined ||
      !("controlDirectory" in root.policy) ||
      root.approval.status !== "approved"
    ) {
      throw new Error("The plan's library is not currently approved.");
    }
    if (!root.policy.allowWrites) {
      throw new Error("The plan's library does not have explicit write approval.");
    }
  }

  private assertActor(actor: string): void {
    if (actor.trim().length === 0) throw new Error("An approving actor is required.");
  }
}
