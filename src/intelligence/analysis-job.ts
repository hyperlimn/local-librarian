import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

import type { ApprovedLibraryRoot, JsonObject, LibraryRootId } from "../domain/index.js";
import {
  JobHandlerFailure,
  JobPauseRequested,
  type JobDefinition,
  type JobExecutionContext,
  type JobHandler,
  type PersistentJobRecord,
  type StructuredJobResult,
} from "../jobs/index.js";
import { categoryForExtension } from "../organization/categorizer.js";
import type { InventoryRootGuard } from "../scanner/index.js";
import type { ReadOnlyRootPathResolver } from "../safety/index.js";
import {
  defaultMetadataAnalyzers,
  type AnalyzerOutcome,
  type LocalMetadataAnalyzer,
} from "./analyzers.js";
import type { SqliteIntelligenceStore } from "./intelligence-store.js";
import {
  applyLocalClassification,
  configuredLocalModel,
  type LocalClassificationEvidence,
} from "./local-model.js";
import type {
  FileUnderstanding,
  HashTask,
  NeedsReviewItem,
  PersistedAnalysisResult,
} from "./types.js";

export const METADATA_ANALYSIS_JOB_DEFINITION: JobDefinition = {
  kind: "media.analyze",
  recoveryMode: "resume-from-checkpoint",
  validatePayload: validatePayload,
};

export const RELATIONSHIP_ANALYSIS_JOB_DEFINITION: JobDefinition = {
  kind: "relationships.analyze",
  recoveryMode: "restart",
  validatePayload: validatePayload,
};

interface AnalysisPayload {
  readonly rootId: string;
  readonly scanId: string;
  readonly rootIdentityKey: string;
}

interface MetadataCheckpoint {
  readonly afterRelativePath?: string;
  readonly afterRecordId?: string;
  readonly processed: number;
  readonly failed: number;
  readonly reusedResults: number;
}

interface TaskAnalysis {
  readonly understanding: FileUnderstanding;
  readonly results: readonly PersistedAnalysisResult[];
  readonly failures: readonly { readonly analyzerId: string; readonly message: string }[];
  readonly reusedResults: number;
}

export class MetadataAnalysisJobHandler implements JobHandler {
  public readonly kind = "media.analyze" as const;
  public readonly recoveryMode = "resume-from-checkpoint" as const;

  public constructor(
    private readonly rootGuard: InventoryRootGuard,
    private readonly rootResolver: ReadOnlyRootPathResolver,
    private readonly store: SqliteIntelligenceStore,
    private readonly analyzers: readonly LocalMetadataAnalyzer[] = defaultMetadataAnalyzers(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    validatePayload(job.payload);
    const payload = job.payload as unknown as AnalysisPayload;
    let checkpoint = metadataCheckpoint(context.checkpoint);
    const totals = await this.store.hashTaskTotals(payload.scanId, "all");
    try {
      const settings = await this.store.settings();
      if (settings.pauseHeavyWork) {
        await this.store.setStage({
          rootId: payload.rootId,
          scanId: payload.scanId,
          stage: "metadata",
          status: "paused",
          jobId: job.id,
          processed: checkpoint.processed,
          total: totals.files,
          details: { reason: "Heavy work is paused in Settings." },
          updatedAt: this.clock().toISOString(),
        });
        throw new JobPauseRequested();
      }
      let root = await this.rootGuard.validateForScan(
        payload.rootId as LibraryRootId,
        payload.rootIdentityKey,
      );
      await this.updateStages(payload, job.id, "running", checkpoint, totals.files);
      const concurrency = settings.throughputMode === "disk-friendly"
        ? 1
        : Math.min(settings.metadataConcurrency, settings.throughputMode === "balanced" ? 2 : 8);
      for (;;) {
        await context.throwIfControlRequested();
        const tasks = await this.store.analysisTasks(
          payload.scanId,
          Math.max(25, concurrency * 4),
          checkpoint.afterRelativePath,
          checkpoint.afterRecordId,
        );
        if (tasks.length === 0) break;
        root = await this.rootGuard.loadApprovedLibrary(root.id, root.identity.key);
        for (let index = 0; index < tasks.length; index += concurrency) {
          await context.throwIfControlRequested();
          const chunk = tasks.slice(index, index + concurrency);
          const outcomes = await Promise.all(chunk.map((task) => this.analyzeTask(root, task)));
          for (let outcomeIndex = 0; outcomeIndex < outcomes.length; outcomeIndex += 1) {
            const task = chunk[outcomeIndex]!;
            const outcome = outcomes[outcomeIndex];
            if (outcome === undefined) {
              checkpoint = {
                ...checkpoint,
                afterRelativePath: task.relativePath,
                afterRecordId: task.recordId,
                processed: checkpoint.processed + 1,
                failed: checkpoint.failed + 1,
              };
              continue;
            }
            for (const result of outcome.results) await this.store.saveAnalyzerResult(result);
            await this.store.saveUnderstanding(outcome.understanding);
            await this.createReviewItems(task, outcome);
            checkpoint = {
              ...checkpoint,
              afterRelativePath: task.relativePath,
              afterRecordId: task.recordId,
              processed: checkpoint.processed + 1,
              failed: checkpoint.failed + (outcome.understanding.analysisState === "failed" ? 1 : 0),
              reusedResults: checkpoint.reusedResults + outcome.reusedResults,
            };
          }
          await context.saveCheckpoint(checkpointToJson(checkpoint));
          const updatedAt = this.clock().toISOString();
          await context.reportProgress({
            phase: "metadata-analysis",
            completedUnits: checkpoint.processed,
            totalUnits: totals.files,
            unit: "items",
            percent: totals.files === 0
              ? 100
              : Math.min(99, Math.floor((checkpoint.processed / totals.files) * 100)),
            message: `Analyzed ${checkpoint.processed.toLocaleString()} of ${totals.files.toLocaleString()} files.`,
            metrics: {
              failures: checkpoint.failed,
              reusedAnalyzerResults: checkpoint.reusedResults,
              concurrency,
            },
            updatedAt,
          });
          await this.updateStages(payload, job.id, "running", checkpoint, totals.files, updatedAt);
        }
      }
      const completedAt = this.clock().toISOString();
      await this.updateStages(payload, job.id, "completed", checkpoint, totals.files, completedAt);
      return {
        summary: {
          rootId: payload.rootId,
          scanId: payload.scanId,
          analyzed: checkpoint.processed,
          failures: checkpoint.failed,
          reusedAnalyzerResults: checkpoint.reusedResults,
        },
        artifacts: [{ kind: "catalog-query", id: payload.scanId }],
        completedAt,
      };
    } catch (error) {
      const status = cooperativeStatus(error) ?? "failed";
      await this.updateStages(
        payload,
        job.id,
        status,
        checkpoint,
        totals.files,
        this.clock().toISOString(),
        status === "failed" ? errorMessage(error) : undefined,
      );
      if (status !== "failed") throw error;
      if (error instanceof JobHandlerFailure) throw error;
      throw new JobHandlerFailure("METADATA_ANALYSIS_FAILED", errorMessage(error), true, {
        rootId: payload.rootId,
        scanId: payload.scanId,
      });
    }
  }

  private async analyzeTask(root: ApprovedLibraryRoot, task: HashTask): Promise<TaskAnalysis | undefined> {
    const now = this.clock().toISOString();
    const decision = await this.rootResolver.resolveExisting(root, task.relativePath);
    if (!decision.allowed) {
      await this.createSourceFailure(task, decision.reason, now);
      return undefined;
    }
    const before = await lstat(decision.authorization.canonicalPath, { bigint: true });
    if (!matchesObservation(before, task)) {
      await this.createSourceFailure(task, "The source no longer matches inventory.", now);
      return undefined;
    }
    const signature = observationSignature(task);
    const results: PersistedAnalysisResult[] = [];
    const failures: { analyzerId: string; message: string }[] = [];
    let reusedResults = 0;
    for (const analyzer of this.analyzers) {
      if (!analyzer.supports(task)) continue;
      const current = await this.store.analyzerResult(
        task.recordId,
        analyzer.id,
        analyzer.version,
        signature,
      );
      if (current !== undefined) {
        results.push(current);
        reusedResults += 1;
        continue;
      }
      const reusable = await this.store.reusableAnalyzerResult(
        task.rootId,
        task.recordId,
        analyzer.id,
        analyzer.version,
        signature,
      );
      if (reusable !== undefined) {
        results.push({
          ...reusable,
          recordId: task.recordId,
          scanId: task.scanId,
          analyzedAt: now,
        });
        reusedResults += 1;
        continue;
      }
      try {
        const outcome = await analyzer.analyze(task, decision.authorization.canonicalPath);
        results.push(resultFor(task, analyzer, signature, outcome, now));
      } catch (error) {
        const message = errorMessage(error);
        failures.push({ analyzerId: analyzer.id, message });
        results.push({
          recordId: task.recordId,
          rootId: task.rootId,
          scanId: task.scanId,
          analyzerId: analyzer.id,
          analyzerVersion: analyzer.version,
          observationSignature: signature,
          status: "failed",
          facts: {},
          warnings: [],
          error: { code: "ANALYZER_FAILED", message },
          analyzedAt: now,
        });
      }
    }
    const after = await lstat(decision.authorization.canonicalPath, { bigint: true });
    if (!matchesObservation(after, task) || !sameFileState(before, after)) {
      await this.createSourceFailure(task, "The source changed during metadata analysis.", now);
      return undefined;
    }
    let understanding = await this.classify(task, results, failures, now);
    const settings = await this.store.settings();
    const model = configuredLocalModel(settings);
    if (model !== undefined && understanding.confidence < 0.8) {
      try {
        const evidence: LocalClassificationEvidence = {
          filename: task.name,
          ...(task.extension === undefined ? {} : { extension: task.extension }),
          parentPath: understanding.parentPath,
          ...(understanding.mimeType === undefined ? {} : { mimeType: understanding.mimeType }),
          deterministicCategory: understanding.category,
          deterministicConfidence: understanding.confidence,
          metadata: understanding.metadata,
          neighboringSignals: [],
        };
        understanding = applyLocalClassification(understanding, await model.classify(evidence), now);
      } catch (error) {
        failures.push({ analyzerId: model.id, message: errorMessage(error) });
      }
    }
    return { understanding, results, failures, reusedResults };
  }

  private async classify(
    task: HashTask,
    results: readonly PersistedAnalysisResult[],
    failures: readonly { readonly analyzerId: string; readonly message: string }[],
    updatedAt: string,
  ): Promise<FileUnderstanding> {
    const metadata: Record<string, JsonObject> = {};
    for (const result of results) {
      if (result.status === "completed") metadata[result.analyzerId] = result.facts;
    }
    const basic = resultFacts(results, "basic-type");
    const mimeType = stringFact(basic, "mimeType");
    const learned = task.extension === undefined
      ? undefined
      : await this.store.classificationRule(task.extension);
    const extensionCategory = categoryForExtension(task.extension);
    const mimeCategory = categoryForMime(mimeType);
    let category = learned ?? extensionCategory;
    let confidence = learned === undefined ? (category === "Other" ? 0.35 : 0.88) : 1;
    let explanation = learned === undefined
      ? category === "Other"
        ? "The extension and local type evidence do not map confidently to a known category."
        : `The deterministic extension baseline classifies this file as ${category}.`
      : `A remembered local rule classifies .${task.extension} files as ${learned}.`;
    let conflicting = false;
    if (mimeCategory !== undefined) {
      if (category === "Other") {
        category = mimeCategory;
        confidence = 0.82;
        explanation = `The locally detected MIME type supports the ${mimeCategory} category.`;
      } else if (mimeCategory !== category) {
        confidence = Math.min(confidence, 0.55);
        conflicting = true;
        explanation = `The extension suggests ${category}, but local type evidence suggests ${mimeCategory}.`;
      } else {
        confidence = Math.max(confidence, 0.94);
        explanation = `The extension and local MIME signature agree on ${category}.`;
      }
    }
    const image = resultFacts(results, "image-metadata");
    const media = resultFacts(results, "ffprobe-media");
    const audio = resultFacts(results, "audio-tags");
    const captureAt = stringFact(image, "captureAt") ?? stringFact(media, "captureAt");
    const video = objectFact(media, "video");
    const width = numberFact(image, "width") ?? numberFact(video, "width");
    const height = numberFact(image, "height") ?? numberFact(video, "height");
    const duration = numberFact(media, "durationSeconds") ?? numberFact(audio, "durationSeconds");
    const supported = results.filter((result) => result.analyzerId !== "basic-type");
    const partial = failures.length > 0 || supported.some((result) => result.status === "unavailable");
    const uncertainty = confidence < 0.65 || conflicting ? "needs-review" : "confident";
    return {
      recordId: task.recordId,
      rootId: task.rootId,
      scanId: task.scanId,
      relativePath: task.relativePath,
      parentPath: parentPath(task.relativePath),
      ...(mimeType === undefined ? {} : { mimeType }),
      category,
      confidence,
      classificationLayer: "deterministic",
      explanation,
      evidence: {
        extension: task.extension ?? "",
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(learned === undefined ? {} : { rememberedRule: true }),
        analyzerVersions: Object.fromEntries(results.map((result) => [result.analyzerId, result.analyzerVersion])),
      },
      uncertainty,
      analysisState: failures.length === results.length
        ? "failed"
        : partial
          ? "partial"
          : "analyzed",
      ...(captureAt === undefined ? {} : { captureAt }),
      ...(duration === undefined ? {} : { durationSeconds: duration }),
      ...(width === undefined ? {} : { width: Math.trunc(width) }),
      ...(height === undefined ? {} : { height: Math.trunc(height) }),
      metadata,
      updatedAt,
    };
  }

  private async createReviewItems(task: HashTask, outcome: TaskAnalysis): Promise<void> {
    const understanding = outcome.understanding;
    if (understanding.uncertainty === "needs-review") {
      await this.store.createNeedsReview(reviewItem(
        task,
        understanding.confidence < 0.65 ? "low-classification-confidence" : "conflicting-metadata",
        understanding.explanation,
        understanding.evidence,
        understanding.updatedAt,
      ));
    }
    if (understanding.category === "Other") {
      await this.store.createNeedsReview(reviewItem(
        task,
        "unsupported-format",
        "No reliable deterministic analyzer or remembered rule recognizes this format yet.",
        { extension: task.extension ?? "", mimeType: understanding.mimeType ?? "" },
        understanding.updatedAt,
      ));
    }
    for (const failure of outcome.failures) {
      await this.store.createNeedsReview(reviewItem(
        task,
        "analysis-failed",
        `${failure.analyzerId}: ${failure.message}`,
        { analyzerId: failure.analyzerId },
        understanding.updatedAt,
      ));
    }
  }

  private async createSourceFailure(task: HashTask, message: string, createdAt: string): Promise<void> {
    await this.store.createNeedsReview(reviewItem(
      task,
      "stale-source",
      message,
      { relativePath: task.relativePath },
      createdAt,
    ));
  }

  private async updateStages(
    payload: AnalysisPayload,
    jobId: string,
    status: "running" | "paused" | "completed" | "failed" | "cancelled",
    checkpoint: MetadataCheckpoint,
    total: number,
    updatedAt = this.clock().toISOString(),
    error?: string,
  ): Promise<void> {
    const details = { failed: checkpoint.failed, reusedAnalyzerResults: checkpoint.reusedResults };
    await Promise.all([
      this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "metadata",
        status,
        jobId,
        processed: checkpoint.processed,
        total,
        details,
        ...(error === undefined ? {} : { error: { code: "METADATA_ANALYSIS_FAILED", message: error } }),
        updatedAt,
      }),
      this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "classification",
        status,
        jobId,
        processed: checkpoint.processed,
        total,
        details: { layers: ["deterministic", "context", "optional-local-model"] },
        ...(error === undefined ? {} : { error: { code: "CLASSIFICATION_FAILED", message: error } }),
        updatedAt,
      }),
    ]);
  }
}

export class RelationshipAnalysisJobHandler implements JobHandler {
  public readonly kind = "relationships.analyze" as const;
  public readonly recoveryMode = "restart" as const;

  public constructor(
    private readonly rootGuard: InventoryRootGuard,
    private readonly store: SqliteIntelligenceStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(
    job: PersistentJobRecord,
    context: JobExecutionContext,
  ): Promise<StructuredJobResult> {
    validatePayload(job.payload);
    const payload = job.payload as unknown as AnalysisPayload;
    let groups = 0;
    let relationships = 0;
    try {
      await this.rootGuard.validateForScan(payload.rootId as LibraryRootId, payload.rootIdentityKey);
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "relationships",
        status: "running",
        jobId: job.id,
        processed: 0,
        details: { methods: ["project-signals", "raw-rendered-pairs", "album-artwork"] },
        updatedAt: this.clock().toISOString(),
      });
      await this.store.clearSemanticAnalysis(payload.scanId);
      let signalCursor: string | undefined;
      const manifests = new Set([
        "package.json", "pyproject.toml", "cargo.toml", "go.mod", "pom.xml",
        "build.gradle", "build.gradle.kts", "composer.json", "gemfile",
      ]);
      for (;;) {
        await context.throwIfControlRequested();
        const signals = await this.store.projectSignals(payload.scanId, 1_000, signalCursor);
        if (signals.length === 0) break;
        for (const signal of signals) {
          signalCursor = signal.relativePath;
          if (!manifests.has(signal.name.toLocaleLowerCase("en-US"))) continue;
          const root = parentPath(signal.relativePath);
          const found = await this.store.observedSignalsAtParent(payload.scanId, root, [
            signal.name, ".git", "src", "README", "README.md", "README.txt",
          ]);
          const confidence = Math.min(0.99, 0.84 + found.length * 0.03);
          const groupId = stableId("semantic-project-v2", payload.scanId, root);
          await this.store.saveSemanticGroup({
            id: groupId,
            rootId: payload.rootId,
            scanId: payload.scanId,
            kind: "project",
            displayName: basename(root) || "Library project",
            ...(root.length === 0 ? {} : { relativeRoot: root }),
            confidence,
            provenance: "deterministic",
            evidence: { manifest: signal.name, signals: found },
            createdAt: this.clock().toISOString(),
            updatedAt: this.clock().toISOString(),
          }, { kind: "path-prefix", relativeRoot: root });
          await this.store.applyGroupContext(
            groupId,
            `Preserved as one software project because ${signal.name} and neighboring project signals were found.`,
            { groupId, signals: found },
            confidence,
            this.clock().toISOString(),
          );
          groups += 1;
        }
        await this.report(context, groups, relationships, "project detection");
      }

      let pairCursor: string | undefined;
      for (;;) {
        await context.throwIfControlRequested();
        const pairs = await this.store.mediaPairCandidates(payload.scanId, 1_000, pairCursor);
        if (pairs.length === 0) break;
        for (const pair of pairs) {
          pairCursor = pair.sourceRelativePath;
          const groupId = stableId(
            "semantic-media-pair-v2",
            payload.scanId,
            pair.sourceRecordId,
            pair.targetRecordId,
          );
          await this.store.saveSemanticGroup({
            id: groupId,
            rootId: payload.rootId,
            scanId: payload.scanId,
            kind: "media-pair",
            displayName: basenameWithoutExtension(pair.sourceRelativePath),
            relativeRoot: parentPath(pair.sourceRelativePath),
            confidence: 0.94,
            provenance: "deterministic",
            evidence: { matchingStem: true, relationship: pair.relationship },
            createdAt: this.clock().toISOString(),
            updatedAt: this.clock().toISOString(),
          }, { kind: "records", recordIds: [pair.sourceRecordId, pair.targetRecordId] });
          await this.store.saveRelationship({
            id: stableId("relationship-v2", payload.scanId, pair.sourceRecordId, pair.targetRecordId, pair.relationship),
            rootId: payload.rootId,
            scanId: payload.scanId,
            sourceRecordId: pair.targetRecordId,
            targetRecordId: pair.sourceRecordId,
            kind: pair.relationship,
            confidence: 0.94,
            provenance: "deterministic",
            evidence: { matchingStem: true, sameDirectory: true },
            createdAt: this.clock().toISOString(),
          });
          groups += 1;
          relationships += 1;
        }
        await this.report(context, groups, relationships, "media-pair detection");
      }

      let albumCursor: string | undefined;
      for (;;) {
        await context.throwIfControlRequested();
        const albums = await this.store.albumCandidates(payload.scanId, 500, albumCursor);
        if (albums.length === 0) break;
        for (const album of albums) {
          albumCursor = album.parentPath;
          const memberIds = await this.store.recordsInParent(payload.scanId, album.parentPath);
          const groupId = stableId("semantic-album-v2", payload.scanId, album.parentPath);
          await this.store.saveSemanticGroup({
            id: groupId,
            rootId: payload.rootId,
            scanId: payload.scanId,
            kind: "album",
            displayName: basename(album.parentPath) || "Music album",
            ...(album.parentPath.length === 0 ? {} : { relativeRoot: album.parentPath }),
            confidence: 0.9,
            provenance: "deterministic",
            evidence: { audioCount: album.audioCount, artworkInSameDirectory: true },
            createdAt: this.clock().toISOString(),
            updatedAt: this.clock().toISOString(),
          }, { kind: "records", recordIds: memberIds });
          await this.store.applyGroupContext(
            groupId,
            "Preserved as an album because multiple audio tracks and artwork share one directory.",
            { groupId, audioCount: album.audioCount },
            0.9,
            this.clock().toISOString(),
          );
          groups += 1;
        }
        await this.report(context, groups, relationships, "album detection");
      }
      const completedAt = this.clock().toISOString();
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "relationships",
        status: "completed",
        jobId: job.id,
        processed: groups,
        total: groups,
        details: { semanticGroups: groups, relationships },
        updatedAt: completedAt,
      });
      return {
        summary: { rootId: payload.rootId, scanId: payload.scanId, semanticGroups: groups, relationships },
        artifacts: [{ kind: "catalog-query", id: payload.scanId }],
        completedAt,
      };
    } catch (error) {
      const status = cooperativeStatus(error) ?? "failed";
      await this.store.setStage({
        rootId: payload.rootId,
        scanId: payload.scanId,
        stage: "relationships",
        status,
        jobId: job.id,
        processed: groups,
        details: { semanticGroups: groups, relationships },
        ...(status === "failed"
          ? { error: { code: "RELATIONSHIP_ANALYSIS_FAILED", message: errorMessage(error) } }
          : {}),
        updatedAt: this.clock().toISOString(),
      });
      if (status !== "failed") throw error;
      throw new JobHandlerFailure("RELATIONSHIP_ANALYSIS_FAILED", errorMessage(error), true);
    }
  }

  private async report(
    context: JobExecutionContext,
    groups: number,
    relationships: number,
    phase: string,
  ): Promise<void> {
    await context.reportProgress({
      phase: "relationship-analysis",
      completedUnits: groups,
      unit: "items",
      message: `Built ${groups.toLocaleString()} semantic groups during ${phase}.`,
      metrics: { semanticGroups: groups, relationships },
      updatedAt: this.clock().toISOString(),
    });
  }
}

function resultFor(
  task: HashTask,
  analyzer: LocalMetadataAnalyzer,
  signature: string,
  outcome: AnalyzerOutcome,
  analyzedAt: string,
): PersistedAnalysisResult {
  return {
    recordId: task.recordId,
    rootId: task.rootId,
    scanId: task.scanId,
    analyzerId: analyzer.id,
    analyzerVersion: analyzer.version,
    observationSignature: signature,
    status: outcome.status,
    facts: outcome.facts,
    warnings: outcome.warnings,
    analyzedAt,
  };
}

function reviewItem(
  task: HashTask,
  reason: NeedsReviewItem["reason"],
  description: string,
  evidence: JsonObject,
  createdAt: string,
): NeedsReviewItem {
  return {
    id: stableId("needs-review-v2", task.scanId, task.recordId, reason),
    rootId: task.rootId,
    scanId: task.scanId,
    recordId: task.recordId,
    reason,
    title: `${reviewTitle(reason)}: ${task.name}`,
    description,
    evidence,
    status: "open",
    createdAt,
  };
}

function reviewTitle(reason: NeedsReviewItem["reason"]): string {
  switch (reason) {
    case "low-classification-confidence": return "Classification needs review";
    case "conflicting-metadata": return "Metadata conflicts";
    case "unsupported-format": return "Unsupported format";
    case "analysis-failed": return "Analyzer needs attention";
    case "stale-source": return "Source changed";
    default: return "Needs review";
  }
}

function resultFacts(results: readonly PersistedAnalysisResult[], analyzerId: string): JsonObject {
  return results.find((result) => result.analyzerId === analyzerId && result.status === "completed")?.facts ?? {};
}

function stringFact(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberFact(value: JsonObject, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}

function objectFact(value: JsonObject, key: string): JsonObject {
  const candidate = value[key];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? candidate as JsonObject
    : {};
}

function categoryForMime(mimeType: string | undefined): string | undefined {
  if (mimeType?.startsWith("image/")) return "Images";
  if (mimeType?.startsWith("video/")) return "Videos";
  if (mimeType?.startsWith("audio/")) return "Audio";
  if (mimeType === "application/pdf" || mimeType?.startsWith("text/")) return "Documents";
  if (["application/zip", "application/gzip", "application/x-tar", "application/x-7z-compressed"].includes(mimeType ?? "")) {
    return "Archives";
  }
  return undefined;
}

function validatePayload(payload: JsonObject): void {
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["rootId", "rootIdentityKey", "scanId"])) {
    throw new Error("Analysis payload must contain only rootId, rootIdentityKey, and scanId.");
  }
  for (const key of keys) {
    if (typeof payload[key] !== "string" || (payload[key] as string).trim().length === 0) {
      throw new Error(`${key} must be a non-empty string.`);
    }
  }
}

function metadataCheckpoint(value: JsonObject | undefined): MetadataCheckpoint {
  if (value === undefined) return { processed: 0, failed: 0, reusedResults: 0 };
  return {
    ...(typeof value["afterRelativePath"] === "string"
      ? { afterRelativePath: value["afterRelativePath"] }
      : {}),
    ...(typeof value["afterRecordId"] === "string" ? { afterRecordId: value["afterRecordId"] } : {}),
    processed: nonNegative(value["processed"]),
    failed: nonNegative(value["failed"]),
    reusedResults: nonNegative(value["reusedResults"]),
  };
}

function checkpointToJson(value: MetadataCheckpoint): JsonObject {
  return {
    ...(value.afterRelativePath === undefined ? {} : { afterRelativePath: value.afterRelativePath }),
    ...(value.afterRecordId === undefined ? {} : { afterRecordId: value.afterRecordId }),
    processed: value.processed,
    failed: value.failed,
    reusedResults: value.reusedResults,
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function matchesObservation(stats: Awaited<ReturnType<typeof lstat>>, task: HashTask): boolean {
  if (!stats.isFile() || stats.isSymbolicLink()) return false;
  if (Number(stats.size) !== task.byteLength) return false;
  if (task.deviceId !== undefined && stats.dev.toString() !== task.deviceId) return false;
  if (task.filesystemRecordId !== undefined && stats.ino.toString() !== task.filesystemRecordId) return false;
  if (task.modifiedAt !== undefined && stats.mtime.toISOString() !== task.modifiedAt) return false;
  return true;
}

function sameFileState(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs;
}

function observationSignature(task: HashTask): string {
  return createHash("sha256")
    .update(`${task.byteLength}\0${task.modifiedAt ?? ""}\0${task.deviceId ?? ""}\0${task.filesystemRecordId ?? ""}`)
    .digest("hex");
}

function parentPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function basenameWithoutExtension(value: string): string {
  const name = basename(value);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}:${createHash("sha256").update(`${prefix}\0${parts.join("\0")}\0`).digest("hex")}`;
}

function cooperativeStatus(error: unknown): "paused" | "cancelled" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "JobPauseRequested") return "paused";
  if (error.name === "JobCancellationRequested") return "cancelled";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis failed.";
}
