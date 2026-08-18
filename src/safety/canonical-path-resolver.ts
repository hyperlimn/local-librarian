import type { CanonicalAbsolutePath } from "../domain/index.js";

/**
 * Filesystem-aware implementations must use realpath semantics and, for a new
 * destination, canonicalize its nearest existing ancestor before rebuilding
 * the suffix. No implementation is included in this phase.
 */
export interface CanonicalPathResolver {
  canonicalizeExisting(path: string): Promise<CanonicalAbsolutePath>;
  canonicalizeProspective(path: string): Promise<CanonicalAbsolutePath>;
}

