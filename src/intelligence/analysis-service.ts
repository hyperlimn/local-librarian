import type { InventoryCatalog } from "../catalog/index.js";
import type { LibraryRoot, LibraryRootId } from "../domain/index.js";
import type { RootEnrollmentStore } from "../enrollment/index.js";
import type { JobClient, JobSubmissionReceipt } from "../jobs/index.js";
import type { AnalysisStageName, AnalysisStatus } from "./types.js";
import type { SqliteIntelligenceStore } from "./intelligence-store.js";

export interface StartProgressiveAnalysisInput {
  readonly rootId: LibraryRootId;
  readonly requestedBy: string;
  readonly stages?: readonly AnalysisStageName[];
  readonly hashScope?: "duplicate-candidates" | "all";
}

export interface ProgressiveAnalysisSubmission {
  readonly rootId: string;
  readonly scanId: string;
  readonly jobs: readonly {
    readonly stage: AnalysisStageName;
    readonly receipt: JobSubmissionReceipt;
  }[];
}

const PIPELINE_VERSION = "2.0.0";

export class AnalysisService {
  public constructor(
    private readonly catalog: InventoryCatalog,
    private readonly enrollments: RootEnrollmentStore,
    private readonly jobs: JobClient,
    private readonly store: SqliteIntelligenceStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public status(rootId: LibraryRootId, scanId?: string): Promise<AnalysisStatus> {
    return this.store.analysisStatus(rootId, scanId);
  }

  public async start(input: StartProgressiveAnalysisInput): Promise<ProgressiveAnalysisSubmission> {
    if (input.requestedBy.trim().length === 0) throw new Error("An analysis actor is required.");
    const [root, summary, settings] = await Promise.all([
      this.enrollments.get(input.rootId),
      this.catalog.summary(input.rootId),
      this.store.settings(),
    ]);
    if (root === undefined || !("controlDirectory" in root.policy) || root.approval.status !== "approved") {
      throw new Error("The library must be approved before analysis.");
    }
    if (settings.pauseHeavyWork) {
      throw new Error("Heavy local work is paused in Settings.");
    }
    const library = root as LibraryRoot;
    const scan = summary.latestScan;
    if (scan === undefined || scan.status !== "completed") {
      throw new Error("A completed inventory scan is required before analysis.");
    }
    if (scan.rootIdentityKey !== library.identity.key) {
      throw new Error("The completed inventory belongs to an older library identity.");
    }
    const preferredStages: readonly AnalysisStageName[] = settings.analysisDepth === "essentials"
      ? ["candidate-duplicates", "content-identity"]
      : [
          "candidate-duplicates",
          "content-identity",
          "metadata",
          "classification",
          "relationships",
        ];
    const requested = new Set<AnalysisStageName>(input.stages ?? preferredStages);
    const hashScope = input.hashScope ?? (
      input.stages === undefined && settings.analysisDepth === "deep"
        ? "all"
        : "duplicate-candidates"
    );
    if (requested.has("classification")) requested.add("metadata");
    if (requested.has("content-identity")) requested.add("candidate-duplicates");
    const submissions: Array<ProgressiveAnalysisSubmission["jobs"][number]> = [];
    const schedule = async (
      stage: AnalysisStageName,
      kind: "duplicates.detect" | "content.hash" | "media.analyze" | "relationships.analyze",
      priority: number,
      payload: Record<string, string>,
    ): Promise<void> => {
      if (!requested.has(stage)) return;
      const receipt = await this.jobs.submit({
        kind,
        payload,
        priority,
        idempotencyKey: `analysis:${PIPELINE_VERSION}:${stage}:${scan.id}:${payload["scope"] ?? "default"}`,
        requestedBy: input.requestedBy.trim(),
        controlPolicy: {
          pauseMode: "checkpoint",
          cancellationMode: "cooperative",
          maximumAttempts: 4,
          leaseDurationMilliseconds: 60_000,
        },
      });
      await this.store.setStage({
        rootId: input.rootId,
        scanId: scan.id,
        stage,
        status: receipt.status === "paused" ? "paused" : receipt.status === "completed" ? "completed" : "queued",
        jobId: receipt.jobId,
        processed: 0,
        details: { pipelineVersion: PIPELINE_VERSION },
        updatedAt: this.clock().toISOString(),
      });
      submissions.push({ stage, receipt });
    };
    await schedule(
      "candidate-duplicates",
      "duplicates.detect",
      40,
      { rootId: input.rootId, scanId: scan.id },
    );
    await schedule(
      "content-identity",
      "content.hash",
      30,
      {
        rootId: input.rootId,
        scanId: scan.id,
        rootIdentityKey: library.identity.key,
        scope: hashScope,
      },
    );
    await schedule(
      "metadata",
      "media.analyze",
      20,
      { rootId: input.rootId, scanId: scan.id, rootIdentityKey: library.identity.key },
    );
    if (requested.has("classification") && !requested.has("metadata")) {
      // Kept for defensive clarity; classification is deliberately part of metadata analysis.
      requested.add("metadata");
    }
    await schedule(
      "relationships",
      "relationships.analyze",
      10,
      { rootId: input.rootId, scanId: scan.id, rootIdentityKey: library.identity.key },
    );
    return { rootId: input.rootId, scanId: scan.id, jobs: submissions };
  }
}
