import type { ContentId } from "./ids.js";

export type ContentHashAlgorithm = "sha256" | "blake3";

/**
 * An identity derived only from bytes, never from a filename, timestamps, or a
 * location. `id` is the normalized `<algorithm>:<lowercase digest>` value.
 */
export interface ContentIdentity {
  readonly id: ContentId;
  readonly algorithm: ContentHashAlgorithm;
  readonly digestHex: string;
  readonly byteLength: number;
  readonly verifiedAt: string;
  readonly formatVersion: 1;
}

export type ContentIdentityState =
  | { readonly status: "not-requested" }
  | { readonly status: "pending" }
  | { readonly status: "verified"; readonly identity: ContentIdentity }
  | { readonly status: "failed"; readonly reason: string };

