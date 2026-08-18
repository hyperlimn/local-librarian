import type { OperationId, PlanId, ProposedOperation } from "../domain/index.js";
import type { AuthorizedOperation } from "../safety/index.js";

export interface ExecutionApproval {
  readonly planId: PlanId;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface ExecutionResult {
  readonly operationId: OperationId;
  readonly status: "succeeded" | "failed";
  readonly completedAt: string;
  readonly inverseOperation?: ProposedOperation;
  readonly message?: string;
}

export interface OperationExecutor {
  execute(
    operation: AuthorizedOperation,
    approval: ExecutionApproval,
  ): Promise<ExecutionResult>;
  rollback(
    operation: AuthorizedOperation,
    approval: ExecutionApproval,
  ): Promise<ExecutionResult>;
}

export class ExecutionDisabledError extends Error {
  public constructor() {
    super("File execution is disabled in the architecture-only scaffold.");
    this.name = "ExecutionDisabledError";
  }
}

/** The only supplied executor is a fail-closed placeholder. */
export class DisabledExecutor implements OperationExecutor {
  public execute(
    _operation: AuthorizedOperation,
    _approval: ExecutionApproval,
  ): Promise<ExecutionResult> {
    return Promise.reject(new ExecutionDisabledError());
  }

  public rollback(
    _operation: AuthorizedOperation,
    _approval: ExecutionApproval,
  ): Promise<ExecutionResult> {
    return Promise.reject(new ExecutionDisabledError());
  }
}

