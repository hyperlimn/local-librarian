# Local Librarian

Local Librarian is an experimental, local-first and privacy-first system for
safely inventorying and, eventually, organizing ordinary files and media. It
keeps its catalog, jobs, approvals, and observations on the local computer and
exposes a loopback-only WebUI. No cloud account or hosted service is required.

> **Project status: experimental pre-release.** The current filesystem feature
> set is strictly **READ-ONLY**. Inventory scanning reads filesystem metadata but
> never opens file contents. **FILE MUTATION: DISABLED** — copying, moving,
> renaming, deleting, quarantine, and restoration are intentionally unavailable.

The architecture is designed around explicit root approval, canonical path
boundaries, append-only audit records, persistent local workers, and a firm
separation between analysis and execution. MCP integration is scaffolded but
does not yet expose a transport-level server.

## Quick start

Prerequisites: Node.js 22.5 or newer and npm.

```sh
npm install
npm run check
npm test
npm run librarian
```

Open [http://localhost:4777](http://localhost:4777). The server binds to the
loopback interface by default and does not expose itself to the LAN. Nothing is
enrolled or scanned automatically; a library must be selected, reviewed, and
explicitly approved before a scan can be submitted.

## Current status

Implemented in this phase:

- TypeScript/Node project configuration.
- Domain contracts for approved library roots, indexed files, content
  identities, immutable provenance, organization plans, operations, ingest
  plans/receipts, persistent jobs, and append-only journal entries.
- Ports for scanners, SQLite catalog storage, JSONL manifests, planners,
  classifiers, media analyzers, duplicate detectors, executors, safety
  validation, journals, and MCP exposure.
- A pure path-boundary component with tests for traversal, sibling-prefix,
  cross-drive, approval, read-only-root, and forged-capability cases.
- A deliberately disabled executor and an MCP layer that exposes no tools.
- An initial SQLite schema, including triggers that reject journal updates and
  deletions and job-history updates and deletions.
- First-class ingest orchestration for folders, drives, SD cards, and drop
  directories, including duplicate-aware plans, review states, transfer
  strategies, and machine-readable receipts.
- Persistent-job contracts for durable submission, leases, checkpoints,
  progress, pause/resume, cancellation, retry, and crash recovery.
- A SQLite-backed persistent queue with atomic lifecycle history, idempotent
  submission, exclusive leases, heartbeat renewal, checkpoint recovery, and
  retry limits.
- An independent local worker loop and a harmless `diagnostic.count` job, plus
  narrow MCP-facing application contracts and local diagnostic CLIs.
- A resumable `inventory.scan` worker job with canonical root enforcement,
  bounded incremental traversal, durable scan sessions/frontiers, batched
  SQLite observations, and summary/list/get queries.
- Read-only root enrollment for library folders/drives and ingest sources,
  including explicit approval, revocation, durable volume-relative identity,
  realpath inspection, and append-only JSONL persistence.
- A loopback-only React/Vite WebUI and narrowly routed local API for drive
  discovery, explicit library enrollment, scan submission/control, inventory
  browsing, job history/results, scan history, and safety diagnostics.
- Read-only Windows logical-volume discovery, detached worker startup, and an
  app-owned heartbeat so the browser can observe worker availability without
  hosting background work.

Not implemented in this phase:

- Content hashing or file-content reads of any kind.
- JSONL inventory manifests or catalog reconciliation between scan sessions.
- Ingest source inventory, transfer, verification, or receipt persistence.
- Classification, media analysis, duplicate detection, or organization logic.
- File creation, movement, renaming, quarantine, restoration, or rollback.
- An MCP SDK transport or callable MCP tools.

## Architecture

The system is divided into ports so analysis, persistence, and mutation remain
independently replaceable:

```text
MCP clients
    |
    v
MCP layer (no tools registered yet)
    |
    +--> analysis/planning --> human review
    |
    +--> jobs.submit --> durable local queue --> job_id returned immediately
                              |
                              v
                       independent local worker
                              |
           canonicalize --> root guard --> metadata scanner
                                             |
                                  separate inventory SQLite catalog

                       safety validator --> disabled executor

Browser at localhost:4777
    |
    v
React WebUI --> fixed local API routes --> the same enrollment/job/catalog ports
                                            |
                               durable queue + independent worker process
```

The source tree follows those boundaries:

```text
src/
  analysis/   Classifier, media analyzer, and duplicate-detector plugins
  domain/     Immutable cross-module types and branded identifiers
  enrollment/ Root proposal, volume identity, approval, persistence, revocation
  ingest/     Source, provenance pipeline, plans, transfers, and receipts
  jobs/       SQLite queue, history, leases, diagnostic handler, worker/recovery
  cli/        Enrollment, submission/query, and independent worker entrypoints
  scanner/    Root guard, metadata-only traversal, inventory job handler
  catalog/    Separate SQLite inventory sessions/frontier/observations and ports
  planner/    Analysis-only organization planning port
  safety/     Canonical-path contract, boundary checks, capability types
  executor/   Mutation port and fail-closed placeholder
  journal/    Append-only journal and integrity-verification ports
  mcp/        Future MCP-facing boundary; currently exposes zero tools
  web/        Loopback HTTP server, API composition, drive and worker adapters
web/
  src/        React pages, reusable components, same-origin API client, styling
test/
  ingest/     Pipeline ordering, transfer strategy, receipt, submission tests
  jobs/       Queue concurrency, leases, controls, retry, and restart tests
  inventory/  Scan safety, scale, metadata, queries, controls, and recovery
  safety/     Boundary and disabled-executor tests
  web/        API, volume discovery, worker separation, and HTTP safety tests
```

Modules depend on domain contracts rather than concrete adapters. A scanner can
therefore change without changing the planner; classifiers, media analyzers,
and duplicate detectors can be added as independent plugins; a SQLite adapter
can be replaced without changing analysis; ingest orchestration depends on the
job client rather than a worker; and an MCP transport cannot bypass the safety
and execution boundaries.

## Local WebUI

The WebUI is the primary human interface and a thin control/observation layer.
It contains no canonicalization, traversal, or queue implementation. Each API
operation calls the same application services used by the CLI/MCP contracts,
and the server exposes a fixed set of resource-specific routes rather than an
arbitrary path or generic filesystem endpoint.

Start the production WebUI from the repository root:

```sh
npm run librarian
```

Then open [http://localhost:4777](http://localhost:4777). The command builds the
Node service and Vite application before binding the server to `127.0.0.1`.
LAN binding is not an option in the runtime contract. The server sets a strict
content-security policy, does not enable CORS, rejects cross-origin state
changes, caps JSON bodies, and validates every ID, enum, query, and body field.

### Local runtime data

Application state is stored outside the source tree by default:

| Platform | Default location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\LocalLibrarian` |
| macOS | `$HOME/Library/Application Support/LocalLibrarian` |
| Linux/Unix | `$XDG_STATE_HOME/local-librarian`, or `$HOME/.local/state/local-librarian` |

Set `LOCAL_LIBRARIAN_STATE_DIR` to use an explicit private location for
development or testing. The WebUI also accepts a one-run override:

```sh
npm run librarian -- --state <state-directory>
```

This directory contains SQLite job and inventory databases, the enrollment
journal, and worker heartbeat state. Treat it as private local data and never
include it in bug reports or source archives without reviewing it first.
Automated tests continue to use dedicated temporary directories.

The pages are:

- **Dashboard:** enrolled libraries, active and recent work, recent scans,
  worker/system status, and failures needing attention.
- **Libraries:** read-only mounted-volume discovery, manual folder selection,
  canonical enrollment review, explicit approval, revocation, and library
  summaries. Creating a proposal never approves it.
- **Inventory:** library selection by display name, scan submission and
  pause/resume/cancel controls, indeterminate progress with concrete counters,
  summary statistics, server-side search/type/extension filters, and cursor
  pagination.
- **Jobs:** durable status, progress, attempts, errors, controls, append-only
  history, and compact structured results.
- **Scans:** retained scan sessions per library with counts, represented bytes,
  duration, status, skips, and errors.
- **Safety & diagnostics:** approved/revoked roots, worker heartbeat, local
  database paths, version/binding state, and the prominent invariant
  `FILE MUTATION: DISABLED`.

The application-shell appearance control switches between purpose-designed
light and dark palettes across every page, dialog, table, form, card, status,
and safety state. The explicit choice is stored in browser `localStorage` under
`local-librarian.theme`. On first use, the UI follows `prefers-color-scheme`;
until an explicit choice is saved, operating-system theme changes are followed
live. A small same-origin initializer applies the theme before the React bundle
and stylesheet render, avoiding a wrong-theme flash during startup. Theme
selection is frontend-only and does not call the local API.

Drive discovery executes one fixed, read-only Windows `Win32_LogicalDisk`
metadata query. It obtains mount path, label, filesystem, capacity/free space,
and drive classification; it does not enumerate any drive directory. Selecting
a displayed drive only fills the proposal form. The user must inspect and
approve the canonical enrollment separately, and the existing enrollment
service repeats its identity checks at approval time.

Starting a scan performs only a short durable queue transaction and returns a
job ID to the API immediately. The web process does not register scan handlers
or instantiate a job loop. If requested, it launches the already-built local
worker as a detached Node process and observes that process through an
application-state heartbeat. Closing either the page or the entire web server
therefore does not stop a running scan. Pause, resume, and cancellation remain
cooperative durable queue state changes.

The browser never receives a path-read endpoint, mutation endpoint, or a
caller-selected job kind. The only filesystem-aware submission route is
`inventory.scan` for a validated library-root ID; the existing submission and
worker-side guards independently require a currently approved, identity-matched
library root. Ingest sources cannot be submitted to that route.

## Read-only root enrollment

Enrollment is implemented as a five-stage workflow:

```text
propose path
  -> read-only canonical inspection
  -> volume/filesystem identity
  -> return an unapproved proposal
  -> explicit approval and metadata-only persistence
```

`RootEnrollmentService.propose` accepts either a `library` root or an
`ingest-source` with a folder, drive, SD-card, or drop-directory kind. The path
must already exist and be a directory. Proposals are deliberately not
`FilesystemBoundaryRoot` objects, so they cannot be passed to scanners or the
safety authorizer. Approval re-inspects the path and refuses it if the durable
identity changed between proposal and approval.

Approved roots default to read-only. Library and ingest enrollments derive
different IDs even when they point to the same directory. Ingest enrollment
sets both `allowWrites` and `allowSourceRetirement` to false; it never creates a
writable library enrollment as a side effect. Scanner and ingest-analysis ports
accept only the explicitly approved root types.

The current durable store is an app-owned, append-only JSONL enrollment journal.
Approval and revocation append records and flush them before returning. Listing
replays the journal, hides revoked roots by default, and can filter by role.
Re-enrolling the same role and durable root updates its display/canonical mount
while retaining its deterministic ID and original creation time.

On Windows, inspection calls `mountvol <mount> /L` read-only when available and
stores the volume GUID separately from the display path. A folder identity is:

```text
SHA-256(version + volume identity + normalized path within the volume)
```

Consequently, `D:\Photos` and `E:\Photos` produce the same identity when they
refer to the same volume GUID. If a GUID is unavailable, the filesystem device
ID is stored with `best-effort` stability and the proposal carries a warning.
The current drive letter is never part of a stable volume key.

`ReadOnlyCanonicalPathResolver` performs only metadata reads. It rejects
relative and drive-relative paths, `..`, null bytes, Windows device namespaces,
and alternate data streams before filesystem access. It uses `lstat` on every
selected component, `realpath` for the final canonical location, `stat` for the
device, and `statfs` where available. The enrolled-root resolver then combines
lexical containment, link/junction refusal, canonical containment, and device
matching so sibling-prefix escapes and unexpected mounted-filesystem crossings
fail closed.

### Windows-specific limitations

- A Windows volume GUID is durable across ordinary drive-letter changes on the
  same host, but is not a hardware serial number and can change after a
  reformat, cloning/restoration, or changes to Windows volume registration.
- If `mountvol` cannot identify the selected volume (for example, some network
  or unusual virtual filesystems), the fallback device ID is only best-effort.
- Node reports symlinks and directory junctions through `lstat`, and those are
  rejected. The standard Node API does not expose every non-link reparse tag;
  cloud placeholders and vendor-specific reparse points may require a future
  native Windows probe before execution can ever be enabled.
- A stored canonical drive-letter path can become stale after remount. A new
  proposal on the replacement letter is recognized by the same durable ID, but
  automatic discovery of a volume's new mount point is not implemented.
- Canonicalization is a point-in-time check. The inventory scanner revalidates
  approval at batch boundaries and canonical/device containment per directory;
  future executors need stronger handle-based checks immediately before any
  mutation.

No directory enumeration occurs during enrollment.

## Metadata-only inventory scanning

`InventoryTools.scan` accepts an enrolled library-root ID and an idempotency
key. It verifies that the enrollment exists, has the library role, and is
currently approved, then submits `inventory.scan` and immediately returns its
durable job receipt. The request never enumerates the root. The independent
local worker repeats all trust checks before traversal, including canonical
root inspection, current volume identity, and the identity key captured during
enrollment.

The scanner's filesystem adapter deliberately exposes only `opendir` and
`lstat`; there is no file-open or content-read operation. It records root- and
scan-relative metadata: deterministic observation ID, relative path, name,
extension, entry type, size for files, birth/modified times, device and inode
identifiers, safely available hidden/read-only attributes, observation time,
job/scan IDs, and structured skip/error details. Every record has content
identity status `not-requested`. Node does not provide portable Windows
hidden/system attribute flags, so dot-prefixed hidden state and mode-based
read-only state are recorded where meaningful; `system` remains unknown.

Traversal is incremental. `opendir` streams directory entries through a small
native buffer; the handler retains at most one configured metadata batch. A
separate SQLite inventory database stores each batch transactionally and keeps
the breadth-first directory frontier in `inventory_scan_frontier`. Pending
directories therefore consume database rows rather than worker memory. No
directory list or complete inventory is assembled in RAM.

Each job has a deterministic scan-session ID and immutable, deterministic
observation IDs. Scan sessions retain status, root/job binding, timestamps,
counters, and the latest compact checkpoint. The job checkpoint contains only
the scan ID, current relative location, and counters; the SQLite frontier is
the authoritative detailed checkpoint. If a process dies after committing a
batch, recovery changes abandoned `processing` frontier rows back to `pending`.
Re-enumeration uses `INSERT OR IGNORE`, so committed observations and counters
are not duplicated. Completed sessions and all prior scan observations are
retained.

Before each directory, the worker resolves and canonically authorizes it under
the enrolled root. It rejects symlinks/junctions, checks the entry device when
`stayOnFileSystem` is enabled, and constructs child paths only from validated
directory-entry names. Approval is re-read at every batch boundary, so
revocation stops traversal before another batch. A vanished, inaccessible,
ignored, reparse, or cross-filesystem entry becomes a structured observation;
it never relaxes the boundary to keep scanning.

Progress intentionally has no percentage because the total is unknown until
enumeration finishes. It reports records/files discovered, directories
visited, represented bytes, errors/skips, and the current relative location.
Pause and cancellation are checked cooperatively at bounded batch boundaries.

`inventory.summary(rootId)` returns the latest session and retained-session
count. `inventory.list(rootId, cursor)` pages the latest scan by default and can
select an older scan. `inventory.get(recordId)` retrieves one observation.
These queries never touch the enrolled filesystem.

The current Node APIs do not expose a portable directory-handle `openat`/
`O_NOFOLLOW` traversal primitive or every Windows reparse tag. Static and
ordinary concurrent symlink/junction escapes are rejected by `lstat`,
`realpath`, canonical containment, and device checks; hostile reparse swaps in
the narrow check-to-open race remain a native hardening item before any future
write capability. Scanning is read-only even under that limitation.

## Safety model

The foundational invariant is:

> No filesystem path becomes executable merely because it is present in a plan
> or supplied by an MCP client.

The intended enforcement sequence is:

1. A user explicitly enrolls a library root or ingest source. Enrollment stores
   its canonical absolute path and an approval record. Removable media never
   becomes trusted merely because it was mounted.
2. Untrusted inputs stay root-relative. Absolute, drive-qualified, alternate
   data stream, root-targeting, and parent-traversal inputs are rejected.
3. Lexical resolution confirms that a candidate does not escape through
   `..`, a sibling with a common prefix, or another drive.
4. The read-only canonicalizer resolves existing paths, records component links
   and junctions, and canonicalizes the nearest existing ancestor for a future
   destination before rebuilding its remaining suffix.
5. The safety layer compares canonical source and destination paths against
   currently approved roots and checks whether writes are enabled.
6. Only that layer can issue a runtime-verifiable `SafetyAuthorization`.
7. Immediately before execution, the operation validator must re-read root
   approval, re-resolve all paths, verify content/size preconditions, check for
   collisions, and issue fresh authorizations.
8. The executor accepts only an `AuthorizedOperation` plus explicit plan
   approval. The supplied executor always fails closed in this phase.

Symlink and junction escapes are now rejected for read authorization by
combining component `lstat`, `realpath`, canonical containment, and device
matching. Mutation safety is still deliberately not claimed: all executors are
disabled, and the Windows limitations above must be addressed before that can
change.

Permanent deletion is not a domain operation. The proposed-operation union only
permits same-filesystem relocation, copy, content verification,
create-directory, quarantine, and restore. A future quarantine must remain
within an approved root, record the original location and content identity, and
retain enough information for restoration.

## Analysis and execution separation

Scanning and planning are read-only phases. A planner returns an immutable plan
with rationale, confidence, source/destination locations, and preconditions. It
cannot invoke an executor. A plan must move through review and explicit approval
before the separate safety-validation and execution pipeline can see it.

Preserving useful organization is represented directly in `IndexedFile` through
`PreservationSignals` and in `PlanningPolicy.preserveExistingFolders`. Future
planners should prefer the smallest explainable set of changes instead of
rebuilding every directory tree.

## Ingest subsystem

An `IngestSource` is an explicitly approved folder, drive, SD card, or drop
directory. It has its own read/write policy; source retirement additionally
requires `allowSourceRetirement`, so approving a source for inventory does not
implicitly permit changing it.

The ingest pipeline is deliberately split at human approval and durable job
submission:

```text
ANALYSIS JOB (read-only, independent of MCP)
source inventory
  -> content identity
  -> exact duplicate lookup
  -> metadata/media analysis
  -> classification
  -> destination planning across approved roots
  -> review-required or ready-for-approval plan

TRANSFER JOB (separately approved; disabled in this scaffold)
background transfer
  -> verify destination content identity
  -> catalog update
  -> journal entries
  -> machine-readable ingest receipt
```

`AnalyzedIngestItem` cannot be constructed without a verified identity and an
explicit exact-duplicate decision. Exact duplicates become no-transfer plan
items. A low-confidence, conflicting, unroutable, or ambiguous classification
becomes `review-required`; the planner has no "best guess" disposition for it.
Confident classifications can carry destination candidates in different
approved library roots.

Every item captures immutable `IngestFileProvenance`: ingest session and source
IDs, source display/volume identity, full original source path, original
root-relative path, exact original filename, and discovery time. Imported
`IndexedFile` records retain an append-only provenance list even after their
current path changes.

The format-versioned ingest receipt records one terminal outcome per discovered
item and totals for discovered, imported, exact duplicates, skipped, failed,
and review-required items. Imported entries include the verified content
identity and destination; duplicate entries point to existing catalog records;
failures are structured and marked retryable or terminal.

Transfer intent and mechanism are separate. A copy uses copy -> identity verify
and leaves the source intact. A known same-filesystem relocation may use rename
-> identity verify. A cross-filesystem relocation is always expanded to:

```text
copy to destination -> verify content identity -> quarantine source
```

The quarantine step cannot begin unless verification succeeds. An unknown
filesystem relationship enters review rather than selecting a relocation
mechanism.

## Persistent local jobs

The governing rule is: **AI thinks; local software works.** MCP plans and
submits; a persistent local worker performs slow I/O independently of Codex or
the client connection.

`SqlitePersistentJobQueue.submit` validates the enabled job definition and
commits a queued record plus its first history event in one short transaction.
It then returns `JobSubmissionReceipt`; it never invokes a handler or waits for
a worker. A unique idempotency key returns the original job for byte-equivalent
work and rejects conflicting reuse. `BEGIN IMMEDIATE` transactions serialize
cross-process submissions, claims, and expired-lease recovery without holding a
transaction open while job work runs.

The SQLite job record stores payload, recovery mode, control policy, progress,
checkpoint, attempts, current lease, structured result/error, revision, and
timestamps. Every state change appends a monotonically sequenced
`job_history` row in the same transaction. SQLite triggers reject history
updates and deletes. WAL mode allows a submitter and worker to use separate
connections to the same application-state database.

`PersistentLocalWorker` is a polling loop with a stable worker ID. It recovers
expired leases before claiming the next supported kind, runs the handler
outside the claim transaction, renews its lease when reporting progress,
persists checkpoints, and atomically completes or fails the attempt. Pause and
cancel requests set durable control flags; the handler observes them at safe
boundaries and acknowledges the resulting state. A paused attempt does not
consume retry budget.

On restart, a `resume-from-checkpoint` job keeps its checkpoint and progress,
while a `restart` job clears them before requeueing. Lease expiration and
handler failure both consume an allowed attempt. Once `maximumAttempts` is
reached, recovery records a terminal structured failure instead of requeueing.
A pending pause or cancellation is also honored when an abandoned lease is
recovered.

Two job definitions are registered by the local worker. `diagnostic.count`
remains the non-filesystem proof job. `inventory.scan` is the sole
filesystem-aware job and is restricted to metadata enumeration under an
approved library root. Hashing, media analysis, duplicate detection, ingest,
transfer, verification, thumbnail, and every mutation job remain unregistered
and fail closed.

`DiagnosticJobTools` provides the application contracts for `jobs.submit`,
`jobs.status`, `jobs.result`, `jobs.history`, `jobs.pause`, `jobs.resume`, and
`jobs.cancel`. Its submission input does not contain a job-kind field, so an
MCP client cannot select a filesystem kind. Status, result, and history are
read-only; submit and controls modify only Local Librarian's job database. The
transport-level MCP server still registers zero tools pending a deliberate
server/authentication boundary.

`InventoryTools` separately fixes submissions to `inventory.scan`, binds the
payload to the enrolled root identity, and provides `inventory.summary`,
`inventory.list`, and `inventory.get`. It never accepts a caller-selected job
kind. The worker revalidates that binding rather than trusting request-time
validation.

The same durable database can be exercised through two separate processes
after building:

```sh
# Returns immediately after the queue commit.
npm run jobs:diagnostic -- submit <state-directory>/jobs.sqlite 100 demo-1

# Run in a different terminal (omit --once to keep polling).
npm run worker:diagnostic -- <state-directory>/jobs.sqlite --once

# Use the jobId printed by submit.
npm run jobs:diagnostic -- status <state-directory>/jobs.sqlite <jobId>
npm run jobs:diagnostic -- result <state-directory>/jobs.sqlite <jobId>
npm run jobs:diagnostic -- history <state-directory>/jobs.sqlite <jobId>
```

The worker can be stopped with `SIGINT`/Ctrl+C after its current cooperative
boundary. The database path is Local Librarian application state, not an
enrolled library root.

The inventory process boundary uses a state directory containing separate job
and inventory databases plus the enrollment journal:

```sh
npm run roots:enroll -- <state-directory> /absolute/test/library "Test library"
npm run inventory -- submit <state-directory> <rootId> scan-demo-1
npm run worker:local -- <state-directory> --once
npm run inventory -- summary <state-directory> <rootId>
```

Do not point this example at a real library until you intend to perform a
metadata-only scan. Automated tests use dedicated temporary directories only.

## Identity and storage

`ContentIdentity` is independent of path, filename, and timestamps. Its stable
key is normalized as `<algorithm>:<lowercase digest>` and includes byte length
for verification. Hashing is optional during discovery and can be completed in
a later pass without changing the file-location record.

SQLite is the query-optimized catalog. JSONL is the portable, inspectable
manifest and audit format. Both represent paths relative to a library root. The
shared schema is in `src/catalog/schema.sql`. Runtime uses one SQLite database
for `jobs`/`job_history` and a physically separate SQLite database for scan
sessions, the durable directory frontier, and inventory observations. This
prevents catalog batch traffic from sharing the queue's short lease/claim
transactions.

A future writable root can reserve an ignored control directory such as:

```text
<approved root>/.local-librarian/
  enrollments.jsonl
  catalog.sqlite
  manifests/
    inventory.jsonl
  journal/
    operations.jsonl
  jobs/
    history.jsonl
  ingest/
    receipts.jsonl
  quarantine/
```

Every metadata or quarantine path still passes through the same approved-root
boundary. The application-state directory described above already keeps the
job queue, catalog, enrollments, and heartbeat outside a library root. Any
future per-library writable control directory would still require a separate,
explicit write approval for that root.

## Journal and rollback design

Every proposal, approval, validation, execution result, and rollback event is a
new immutable journal entry. Ingest milestones and job lifecycle events are
journaled as well. Entries carry monotonic sequence numbers,
correlation IDs, the previous entry hash, and their own hash so integrity can be
verified. SQLite stores a queryable mirror and rejects update/delete statements;
JSONL remains the append-only source of audit history.

Successful future operations must journal an inverse operation based on what
actually occurred, not merely on what was planned. Rollback is another reviewed
and journaled plan, subject to the same root checks, canonicalization,
preconditions, and collision handling as forward execution.

## Development

Prerequisites: Node.js 22.5 or newer.

```sh
npm install
npm run check
npm test
npm run build
```

The production build emits the Node service to `dist/` and the browser bundle
to `web-dist/`. `npm run web` starts an already-built WebUI; `npm run librarian`
is the normal build-and-launch command.

Development dependencies are installed locally and locked by `package-lock.json`.
The minimum runtime is Node.js 22.5 because the queue uses the built-in
`node:sqlite` API. Node 22 currently prints an experimental-feature warning for
that API; the queue does not depend on a native third-party package, but the API
should be revalidated when upgrading Node.

## Next development step

Implement a read-only reconciliation service and WebUI view that compares two
completed scan sessions and reports added, missing, and metadata-changed paths
without deleting or rewriting either session's observations.
