import type {
  ContentIdentity,
  IngestItemId,
  IngestPlanId,
  IngestSessionId,
  LibraryLocation,
} from "../domain/index.js";
import type {
  AnalyzedIngestItem,
  ExactDuplicateMatch,
  IngestClassificationDecision,
} from "./ingest-item.js";
import type { IngestSourceLocation } from "./source.js";
import type {
  FileSystemRelationship,
  TransferIntent,
  TransferStrategy,
  TransferStep,
} from "./transfer-strategy.js";

export interface PlannedIngestTransfer {
  readonly source: IngestSourceLocation;
  readonly destination: LibraryLocation;
  readonly intent: TransferIntent;
  readonly fileSystemRelationship: FileSystemRelationship;
  readonly strategy: TransferStrategy;
  readonly steps: readonly TransferStep[];
  readonly expectedIdentity: ContentIdentity;
}

export type IngestPlanItem =
  | {
      readonly disposition: "exact-duplicate";
      readonly ingestItemId: IngestItemId;
      readonly matches: readonly ExactDuplicateMatch[];
      readonly transferRequired: false;
    }
  | {
      readonly disposition: "review-required";
      readonly ingestItemId: IngestItemId;
      readonly classification: Extract<
        IngestClassificationDecision,
        { readonly status: "review-required" }
      >;
      readonly transferRequired: false;
    }
  | {
      readonly disposition: "transfer-planned";
      readonly ingestItemId: IngestItemId;
      readonly transfer: PlannedIngestTransfer;
      readonly transferRequired: true;
    }
  | {
      readonly disposition: "skipped";
      readonly ingestItemId: IngestItemId;
      readonly reason: string;
      readonly transferRequired: false;
    }
  | {
      readonly disposition: "analysis-failed";
      readonly ingestItemId: IngestItemId;
      readonly code: string;
      readonly message: string;
      readonly transferRequired: false;
    };

export type IngestPlanStatus =
  | "draft"
  | "review-required"
  | "ready-for-approval"
  | "approved"
  | "submitted"
  | "completed"
  | "failed";

export interface IngestPlan {
  readonly id: IngestPlanId;
  readonly sessionId: IngestSessionId;
  readonly status: IngestPlanStatus;
  readonly items: readonly IngestPlanItem[];
  readonly createdAt: string;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
}

export interface IngestPlanningPolicy {
  readonly minimumClassificationConfidence: number;
  readonly defaultTransferIntent: TransferIntent;
  readonly requireReviewForMultipleDestinations: boolean;
  readonly preserveSourceFolders: boolean;
}

/** Analysis-only planner. It cannot submit jobs or execute transfers. */
export interface IngestPlanner {
  createPlan(
    sessionId: IngestSessionId,
    items: AsyncIterable<AnalyzedIngestItem>,
    policy: IngestPlanningPolicy,
  ): Promise<IngestPlan>;
}

