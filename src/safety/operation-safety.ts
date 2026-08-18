import type {
  LibraryRoot,
  ProposedOperation,
} from "../domain/index.js";
import type { SafetyAuthorization } from "./path-boundary.js";

export interface AuthorizedOperation {
  readonly operation: ProposedOperation;
  readonly authorizations: readonly SafetyAuthorization[];
  readonly validatedAt: string;
}

/**
 * Re-resolves sources and destinations, checks preconditions, and issues path
 * capabilities immediately before execution. Implementation intentionally
 * deferred until the read-only scanner and canonicalizer exist.
 */
export interface OperationSafetyValidator {
  validate(
    operation: ProposedOperation,
    roots: readonly LibraryRoot[],
  ): Promise<AuthorizedOperation>;
}

