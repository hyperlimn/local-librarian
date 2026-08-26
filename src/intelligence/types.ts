import type { JsonObject } from "../domain/index.js";

export type AnalysisStageName =
  | "candidate-duplicates"
  | "content-identity"
  | "metadata"
  | "relationships"
  | "classification";

export type DurableStageStatus =
  | "not-started"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface AnalysisStageState {
  readonly rootId: string;
  readonly scanId: string;
  readonly stage: AnalysisStageName;
  readonly status: DurableStageStatus;
  readonly jobId?: string;
  readonly processed: number;
  readonly total?: number;
  readonly details: JsonObject;
  readonly error?: { readonly code: string; readonly message: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface AnalysisStatus {
  readonly rootId: string;
  readonly scanId?: string;
  readonly stages: readonly AnalysisStageState[];
  readonly totals: {
    readonly files: number;
    readonly analyzed: number;
    readonly hashesVerified: number;
    readonly hashesReused: number;
    readonly candidateDuplicateGroups: number;
    readonly exactDuplicateGroups: number;
    readonly needsReview: number;
    readonly semanticGroups: number;
  };
}

export type ContentVerificationState = "verified" | "reused";

export interface ContentHashObservation {
  readonly recordId: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly relativePath: string;
  readonly algorithm: "sha256";
  readonly digestHex: string;
  readonly byteLength: number;
  readonly observedModifiedAt?: string;
  readonly observedDeviceId?: string;
  readonly observedFilesystemRecordId?: string;
  readonly hashedAt: string;
  readonly verificationState: ContentVerificationState;
  readonly reusedFromRecordId?: string;
}

export interface HashTask {
  readonly recordId: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly relativePath: string;
  readonly name: string;
  readonly extension?: string;
  readonly byteLength: number;
  readonly modifiedAt?: string;
  readonly deviceId?: string;
  readonly filesystemRecordId?: string;
}

export type DuplicateGroupKind = "candidate" | "exact";

export interface DuplicateGroupSummary {
  readonly id: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly kind: DuplicateGroupKind;
  readonly groupKey: string;
  readonly copyCount: number;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly reclaimableBytes: number;
  readonly verificationState: "candidate" | "partially-verified" | "verified";
  readonly keeperCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DuplicateGroupMember {
  readonly groupId: string;
  readonly recordId: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly relativePath: string;
  readonly name: string;
  readonly libraryDisplayName?: string;
  readonly byteLength: number;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly hashState: "not-hashed" | "verified" | "reused";
  readonly decision: "undecided" | "keep" | "consolidate" | "keep-all";
}

export interface DuplicateGroupPage {
  readonly items: readonly DuplicateGroupSummary[];
  readonly nextCursor?: string;
}

export interface DuplicateMemberPage {
  readonly items: readonly DuplicateGroupMember[];
  readonly nextCursor?: string;
}

export interface DuplicateGroupQuery {
  readonly rootId?: string;
  readonly kind?: DuplicateGroupKind;
  readonly verificationState?: DuplicateGroupSummary["verificationState"];
  readonly search?: string;
  readonly minimumReclaimableBytes?: number;
  readonly sort?: "reclaimable-desc" | "copies-desc" | "size-desc" | "updated-desc";
  readonly limit?: number;
  readonly cursor?: string;
}

export type AnalyzerOutcomeStatus = "completed" | "unavailable" | "failed";

export interface PersistedAnalysisResult {
  readonly recordId: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly observationSignature: string;
  readonly status: AnalyzerOutcomeStatus;
  readonly facts: JsonObject;
  readonly warnings: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
  readonly analyzedAt: string;
}

export type ClassificationLayer = "deterministic" | "context" | "local-model";

export interface FileUnderstanding {
  readonly recordId: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly relativePath: string;
  readonly parentPath: string;
  readonly mimeType?: string;
  readonly category: string;
  readonly confidence: number;
  readonly classificationLayer: ClassificationLayer;
  readonly explanation: string;
  readonly evidence: JsonObject;
  readonly uncertainty: "confident" | "needs-review";
  readonly analysisState: "pending" | "analyzed" | "partial" | "failed";
  readonly captureAt?: string;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly metadata: JsonObject;
  readonly updatedAt: string;
}

export type SemanticGroupKind = "project" | "album" | "media-pair" | "media-event";

export interface SemanticGroup {
  readonly id: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly kind: SemanticGroupKind;
  readonly displayName: string;
  readonly relativeRoot?: string;
  readonly confidence: number;
  readonly provenance: "deterministic" | "local-model" | "user";
  readonly evidence: JsonObject;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RelationshipKind =
  | "exact-duplicate-of"
  | "likely-belongs-with"
  | "same-project"
  | "same-media-event"
  | "sidecar-of"
  | "derived-version"
  | "alternate-encoding"
  | "parent-child-project";

export interface FileRelationship {
  readonly id: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly sourceRecordId: string;
  readonly targetRecordId: string;
  readonly kind: RelationshipKind;
  readonly confidence: number;
  readonly provenance: "deterministic" | "local-model" | "user";
  readonly evidence: JsonObject;
  readonly createdAt: string;
}

export type ReviewReason =
  | "low-classification-confidence"
  | "conflicting-metadata"
  | "ambiguous-destination"
  | "duplicate-keeper-uncertain"
  | "unsafe-collision"
  | "broken-project-relationship"
  | "stale-source"
  | "unsupported-format"
  | "analysis-failed";

export interface NeedsReviewItem {
  readonly id: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly recordId?: string;
  readonly groupId?: string;
  readonly reason: ReviewReason;
  readonly title: string;
  readonly description: string;
  readonly evidence: JsonObject;
  readonly status: "open" | "resolved" | "dismissed";
  readonly resolution?: JsonObject;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

export interface NeedsReviewPage {
  readonly items: readonly NeedsReviewItem[];
  readonly nextCursor?: string;
}

export interface NeedsReviewQuery {
  readonly rootId?: string;
  readonly scanId?: string;
  readonly reason?: ReviewReason;
  readonly status?: NeedsReviewItem["status"];
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface EnrichedInventoryItem {
  readonly recordId: string;
  readonly rootId: string;
  readonly scanId: string;
  readonly relativePath: string;
  readonly name: string;
  readonly extension?: string;
  readonly byteLength?: number;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly mimeType?: string;
  readonly category?: string;
  readonly captureAt?: string;
  readonly durationSeconds?: number;
  readonly hashState: "not-requested" | "verified" | "reused";
  readonly duplicateState: "none" | "candidate" | "exact";
  readonly analysisState: "not-analyzed" | "analyzed" | "partial" | "failed";
  readonly needsReview: boolean;
  readonly semanticGroups: readonly { readonly id: string; readonly kind: SemanticGroupKind; readonly displayName: string }[];
}

export interface EnrichedInventoryPage {
  readonly items: readonly EnrichedInventoryItem[];
  readonly nextCursor?: string;
}

export interface EnrichedInventoryQuery {
  readonly scanId?: string;
  readonly search?: string;
  readonly extension?: string;
  readonly category?: string;
  readonly mimeType?: string;
  readonly minimumBytes?: number;
  readonly maximumBytes?: number;
  readonly modifiedAfter?: string;
  readonly modifiedBefore?: string;
  readonly captureAfter?: string;
  readonly captureBefore?: string;
  readonly duplicateState?: EnrichedInventoryItem["duplicateState"];
  readonly hashState?: EnrichedInventoryItem["hashState"];
  readonly analysisState?: EnrichedInventoryItem["analysisState"];
  readonly needsReview?: boolean;
  readonly semanticGroupId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export type ReconciliationStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type ReconciliationDeltaKind = "added" | "missing" | "metadata-changed";

export interface PersistedReconciliation {
  readonly id: string;
  readonly rootId: string;
  readonly baselineScanId: string;
  readonly comparisonScanId: string;
  readonly jobId?: string;
  readonly status: ReconciliationStatus;
  readonly phase: "missing" | "added" | "changed" | "complete";
  readonly processed: number;
  readonly counts: {
    readonly added: number;
    readonly missing: number;
    readonly metadataChanged: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface PersistedReconciliationDelta {
  readonly id: number;
  readonly reconciliationId: string;
  readonly relativePath: string;
  readonly kind: ReconciliationDeltaKind;
  readonly changedFields: readonly string[];
  readonly before?: JsonObject;
  readonly after?: JsonObject;
}

export interface ReconciliationDeltaPage {
  readonly items: readonly PersistedReconciliationDelta[];
  readonly nextCursor?: string;
}

export interface IntelligenceSummary {
  readonly filesAnalyzed: number;
  readonly filesAwaitingAnalysis: number;
  readonly candidateDuplicateGroups: number;
  readonly exactDuplicateGroups: number;
  readonly reclaimableDuplicateBytes: number;
  readonly needsReview: number;
  readonly quarantineCount: number;
}

export type ThroughputMode = "disk-friendly" | "balanced" | "maximum";
export type AnalysisDepth = "essentials" | "standard" | "deep";

export interface ResourceSettings {
  readonly maximumHashingWorkers: number;
  readonly metadataConcurrency: number;
  readonly transferConcurrency: number;
  readonly throughputMode: ThroughputMode;
  readonly pauseHeavyWork: boolean;
  readonly analysisDepth: AnalysisDepth;
  readonly localModel: {
    readonly enabled: boolean;
    readonly adapter: "ollama" | "custom";
    readonly endpoint: string;
    readonly model: string;
    readonly allowTextSamples: boolean;
  };
}

export const DEFAULT_RESOURCE_SETTINGS: ResourceSettings = {
  maximumHashingWorkers: 1,
  metadataConcurrency: 2,
  transferConcurrency: 1,
  throughputMode: "disk-friendly",
  pauseHeavyWork: false,
  analysisDepth: "standard",
  localModel: {
    enabled: false,
    adapter: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "",
    allowTextSamples: false,
  },
};
