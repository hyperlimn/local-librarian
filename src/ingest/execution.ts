import type { IngestItemId } from "../domain/index.js";
import type { SafetyAuthorization } from "../safety/index.js";
import type { PlannedIngestTransfer } from "./ingest-plan.js";
import type { IngestSource } from "./source.js";

export interface AuthorizedIngestTransfer {
  readonly ingestItemId: IngestItemId;
  readonly transfer: PlannedIngestTransfer;
  readonly sourceReadAuthorization: SafetyAuthorization;
  readonly destinationWriteAuthorization: SafetyAuthorization;
  /** Required only when the verified strategy retires the source. */
  readonly sourceRetirementAuthorization?: SafetyAuthorization;
  readonly validatedAt: string;
}

export interface IngestTransferSafetyValidator {
  validate(
    ingestItemId: IngestItemId,
    transfer: PlannedIngestTransfer,
    source: IngestSource,
  ): Promise<AuthorizedIngestTransfer>;
}

export interface IngestTransferExecutionResult {
  readonly ingestItemId: IngestItemId;
  readonly destinationVerified: true;
  readonly sourceOutcome: "preserved" | "quarantined";
  readonly completedAt: string;
}

/** Worker-only port; it must never be invoked from an MCP handler. */
export interface IngestTransferExecutor {
  execute(
    transfer: AuthorizedIngestTransfer,
  ): Promise<IngestTransferExecutionResult>;
}

export class IngestExecutionDisabledError extends Error {
  public constructor() {
    super("Ingest transfer execution is disabled in this scaffold.");
    this.name = "IngestExecutionDisabledError";
  }
}

export class DisabledIngestTransferExecutor implements IngestTransferExecutor {
  public execute(
    _transfer: AuthorizedIngestTransfer,
  ): Promise<IngestTransferExecutionResult> {
    return Promise.reject(new IngestExecutionDisabledError());
  }
}

