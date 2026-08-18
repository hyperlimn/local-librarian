import type {
  CanonicalAbsolutePath,
  FilesystemRootIdentity,
  IngestSourceId,
  LibraryRootId,
} from "../domain/index.js";
import type { IngestSourceKind } from "../ingest/index.js";

export type RootEnrollmentRole = "library" | "ingest-source";

interface RootProposalInputBase {
  readonly path: string;
  readonly displayName: string;
}

export interface LibraryRootProposalInput extends RootProposalInputBase {
  readonly role: "library";
}

export interface IngestSourceProposalInput extends RootProposalInputBase {
  readonly role: "ingest-source";
  readonly ingestSourceKind: IngestSourceKind;
}

export type RootProposalInput =
  | LibraryRootProposalInput
  | IngestSourceProposalInput;

interface RootEnrollmentProposalBase {
  readonly proposalId: string;
  readonly displayName: string;
  readonly displayPath: string;
  readonly canonicalPath: CanonicalAbsolutePath;
  readonly identity: FilesystemRootIdentity;
  readonly warnings: readonly string[];
  readonly approvalRequired: true;
  readonly proposedAt: string;
}

export interface LibraryRootEnrollmentProposal
  extends RootEnrollmentProposalBase {
  readonly role: "library";
}

export interface IngestSourceEnrollmentProposal
  extends RootEnrollmentProposalBase {
  readonly role: "ingest-source";
  readonly ingestSourceKind: IngestSourceKind;
}

export type RootEnrollmentProposal =
  | LibraryRootEnrollmentProposal
  | IngestSourceEnrollmentProposal;

export type EnrolledRootId = LibraryRootId | IngestSourceId;

export interface EnrolledRootListQuery {
  readonly role?: RootEnrollmentRole;
  readonly includeRevoked?: boolean;
}

