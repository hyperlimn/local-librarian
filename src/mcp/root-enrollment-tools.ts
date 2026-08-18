import type {
  ApprovedEnrolledRoot,
  EnrolledRoot,
  EnrolledRootId,
  EnrolledRootListQuery,
  RootEnrollmentProposal,
  RootProposalInput,
} from "../enrollment/index.js";

/**
 * MCP contract only. The transport-level server still registers no tools.
 * propose/list inspect or read state; approve/revoke mutate enrollment metadata
 * only and never touch files under an enrolled root.
 */
export interface McpRootEnrollmentTools {
  propose(input: RootProposalInput): Promise<RootEnrollmentProposal>;
  approve(
    proposalId: string,
    approvedBy: string,
  ): Promise<ApprovedEnrolledRoot>;
  list(query?: EnrolledRootListQuery): Promise<readonly EnrolledRoot[]>;
  revoke(
    rootId: EnrolledRootId,
    reason: string,
  ): Promise<EnrolledRoot>;
}
