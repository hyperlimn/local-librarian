import type {
  IndexedFile,
  LibraryRoot,
  OperationPlan,
} from "../domain/index.js";

export interface PlanningPolicy {
  readonly preserveExistingFolders: boolean;
  readonly minimumConfidence: number;
  readonly maximumOperations: number;
  readonly allowCrossRootOperations: boolean;
}

export interface PlanningContext {
  readonly roots: readonly LibraryRoot[];
  readonly files: AsyncIterable<IndexedFile>;
  readonly policy: PlanningPolicy;
}

/** Pure analysis port. Planners propose operations but cannot execute them. */
export interface OrganizationPlanner {
  createPlan(context: PlanningContext): Promise<OperationPlan>;
}

