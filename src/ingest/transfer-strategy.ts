export type TransferIntent = "copy" | "relocate";
export type FileSystemRelationship =
  | "same-filesystem"
  | "cross-filesystem"
  | "unknown";

export type TransferStep =
  | "copy-to-destination"
  | "same-filesystem-rename"
  | "verify-content-identity"
  | "quarantine-source";

export type TransferStrategy =
  | "copy-verify-preserve-source"
  | "same-filesystem-rename"
  | "cross-filesystem-copy-verify-quarantine-source";

export type TransferStrategyDecision =
  | {
      readonly status: "planned";
      readonly strategy: TransferStrategy;
      readonly steps: readonly TransferStep[];
    }
  | {
      readonly status: "review-required";
      readonly reason: string;
    };

/** Pure planning logic; it performs no filesystem operation. */
export function selectTransferStrategy(
  intent: TransferIntent,
  relationship: FileSystemRelationship,
): TransferStrategyDecision {
  if (intent === "copy") {
    return {
      status: "planned",
      strategy: "copy-verify-preserve-source",
      steps: ["copy-to-destination", "verify-content-identity"],
    };
  }

  if (relationship === "same-filesystem") {
    return {
      status: "planned",
      strategy: "same-filesystem-rename",
      steps: ["same-filesystem-rename", "verify-content-identity"],
    };
  }

  if (relationship === "cross-filesystem") {
    return {
      status: "planned",
      strategy: "cross-filesystem-copy-verify-quarantine-source",
      steps: [
        "copy-to-destination",
        "verify-content-identity",
        "quarantine-source",
      ],
    };
  }

  return {
    status: "review-required",
    reason:
      "A relocation cannot be planned until the filesystem relationship is known.",
  };
}

