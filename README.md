# Local Librarian

Local Librarian 2.0 is a private, local-first application for understanding,
reconciling, ingesting, and organizing messy file libraries. It combines a
loopback-only WebUI with durable background jobs, progressive content analysis,
reviewable plans, verified transfers, recoverable quarantine, and explicit
write gates.

No account or hosted service is required. Inventory, hashes, metadata,
classifications, paths, decisions, and receipts remain in local application
state. Optional model inference is disabled by default and restricted to an
HTTP service on the same computer.

> **Safety:** fresh installations are read-only. Live operations require a
> global mutation switch, explicit write approval for each affected library,
> plan-specific typed confirmation, and execution-time revalidation. Local
> Librarian never overwrites a destination and has no permanent-delete feature.
> Keep normal backups of important data.

> **License status:** this repository does not currently contain a `LICENSE`
> file. Public visibility alone does not grant reuse or redistribution rights.
> The repository owner should choose and add a license before inviting external
> contributions or reuse.

## Quick start

Prerequisites:

- Node.js `^20.19.0` or `>=22.12.0` (the included `.nvmrc` selects 22.12.0)
- npm

```sh
npm install
npm start
```

Open [http://localhost:4777](http://localhost:4777). The start command builds
the TypeScript server and React WebUI, binds the application to loopback, and
starts the independent local worker. Submitted jobs and checkpoints survive a
browser or application restart.

Run the release gate with:

```sh
npm run verify
```

This type-checks both applications, runs the complete test suite, and builds the
production bundles.

## Recommended workflow

1. **Enroll a library.** Inspect the selected folder or mounted volume, review
   its canonical path and volume identity, then explicitly approve it. A new
   library starts read-only.
2. **Inventory it.** Run a fast metadata-only scan. Traversal is resumable,
   bounded, does not follow symlinks, and stays on the enrolled filesystem.
3. **Analyze progressively.** Start with duplicate candidates and selectively
   add SHA-256 content identity, bounded format metadata, classification, and
   related-file/project grouping. Analysis is separate from scanning because it
   opens file content.
4. **Resolve uncertainty.** Review ambiguous or failed analysis in **Needs
   Review**. Review decisions are durable; an extension rule is remembered only
   when explicitly requested.
5. **Review duplicates.** Candidate groups are evidence for more work, not proof.
   Only complete SHA-256 matches are shown as verified exact duplicates.
6. **Organize or transfer.** Build an immutable plan, inspect every operation,
   and simulate same-volume moves. Cross-volume work uses verified staged copies.
7. **Approve mutation deliberately.** Enable global live mode and the relevant
   root write gates, type the plan-specific phrase, then monitor Jobs and the
   resulting receipts.
8. **Recover when needed.** Organization moves can be rolled back. Retired
   source copies and consolidated duplicates can be restored from Quarantine
   while their retention window and destination constraints permit it.

## Content intelligence

Analysis is modular, local, restartable, and tied to an immutable completed
scan. Each stage has its own durable job and checkpoint.

### Content identity and duplicates

- Candidate grouping uses metadata such as size to avoid reading every file by
  default.
- SHA-256 hashing is streamed with bounded concurrency and records source file
  identity before accepting a result.
- Hashes are reused across scans only when the cataloged size, timestamps,
  device, and filesystem-record identity still match.
- Exact groups require matching verified content identity. Candidate and exact
  results are visibly distinct.
- Keeper/consolidation decisions survive refreshes. Consolidation moves selected
  redundant copies into recoverable quarantine; it does not delete them.

The Analyze page can hash duplicate candidates or explicitly hash all observed
files. Hashing an entire large library can be I/O intensive, so the conservative
candidate scope is the default.

### Local metadata analyzers

The built-in analyzers are isolated: one parser failure is recorded against that
file and does not stop the remaining library.

- Signature and extension-based type detection
- Bounded image-container metadata
- ID3 and WAVE facts
- Safe PDF structural metadata and page-count estimate
- ZIP central-directory facts and bounded archive identification without
  extraction
- Optional `ffprobe` facts for audio and video when that executable is already
  installed

The analyzer is intentionally not a universal document renderer, archive
extractor, or media decoder. Unsupported or uncertain results remain visible
instead of being presented as facts.

### Classification and relationships

Classification combines deterministic extension and MIME evidence, remembered
local rules, confidence, an explanation, and an explicit uncertainty state.
Conservative relationship analysis recognizes project roots and related
collections so organization planning can preserve coherent groups.

An optional Ollama or structured HTTP classifier can refine low-confidence
results. It is off by default, accepts only loopback HTTP endpoints, uses compact
metadata evidence with location fields removed, and validates structured output
before saving it. The text-sample setting is reserved and the current classifier
does not send file text.

## Organization

Plans are deterministic snapshots tied to one completed inventory and the
current enrolled root identity.

| Setting | Choices | Default |
| --- | --- | --- |
| Philosophy | conservative; balanced; deep | balanced (recommended) |
| Structure | category; category then year; year then month | category then year |
| Scope | loose top-level files; all files | loose top-level files |
| Destination | safe root-relative directory | `Organized` |
| Collision policy | keep both with suffix; skip | keep both |
| Hidden files | include; exclude | exclude |
| Maximum moves | 1–50,000 | 10,000 |

The planner preserves existing folders under top-level scope. With all-files
scope it can preserve detected projects and related groups, and it excludes
unresolved items rather than guessing. Every preview records source evidence,
destination, rationale, represented bytes, and collision outcome.

Simulation reruns filesystem safety checks but creates no directories and moves
no files. Live relocation uses a same-filesystem atomic rename and records a
per-item receipt. Rollback processes only successfully moved files, in reverse
order, after revalidating the current source and destination states.

## Ingest, cross-volume transfer, and quarantine

Ingest sources are enrolled separately from managed libraries and begin
read-only. Source retirement requires its own write and retirement switch in
addition to the global mutation gate and destination write approval.

A transfer follows this sequence:

```text
reviewed plan
  -> revalidate source and destination roots
  -> check destination capacity and collisions
  -> copy to an app-owned staging file on the destination volume
  -> resume from a durable byte checkpoint if interrupted
  -> verify SHA-256 and source stability
  -> atomically promote staging to the final destination
  -> catalog and receipt
  -> optionally move the verified source into quarantine
```

If capacity is insufficient, a root is disconnected, a source changes or
disappears, a symlink/reparse point appears, verification fails, or a
destination collides, the item fails closed. Existing destinations are never
replaced. Copy-only ingest leaves every source in place.

Cross-volume organization uses the same copy/verify/promote protocol and
requires content identity for selected source records. Source retirement occurs
only after the destination has been verified. Quarantine restore is separately
confirmed and refuses an occupied original path.

## Read-only and live modes

The global mutation mode is persisted in `organization.sqlite` and defaults to
`read-only`. Read-only mode permits enrollment inspection, inventory,
analysis, search, reconciliation, planning, and organization simulation.

Live mutation requires all applicable gates:

- global **Live file mutation** mode;
- explicit write approval on every managed source or destination library;
- explicit retirement approval for a removable ingest source when requested;
- the exact operation-specific confirmation phrase.

Returning global mode to read-only takes effect at the next per-file boundary.
Jobs support cooperative pause/cancel behavior; checkpoints keep recovery
idempotent.

## Filesystem safety contract

Workers do not trust plan-time observations as continuing authority. At
execution time they recheck:

- current approval and durable root/volume identity;
- global and per-root mutation policy;
- canonical containment within the enrolled root;
- parent traversal, absolute paths, reserved control paths, symlinks, junctions,
  reparse points, and filesystem boundaries;
- regular-file type plus recorded size, modification time, device, and
  filesystem-record identity;
- destination nonexistence and safe parent construction.

Organization uses same-filesystem rename. Transfer promotion uses a staging
file on the destination filesystem, verifies bytes before promotion, then uses
an atomic no-overwrite rename. A crash after the filesystem operation but before
the receipt is recognized as already completed during recovery.

Mutation mode changes, organization plans/runs/outcomes, transfers, quarantine,
and restores have durable audit or receipt records. Organization audit events
form a SHA-256 chain protected from update/delete by SQLite triggers.

## Large-library behavior

The application avoids loading entire inventories into memory or rendering them
in one browser response.

- Inventory scanning persists traversal frontiers and observations in batches of
  256 by default.
- Hashing and metadata analysis use bounded concurrency and checkpoint after
  small chunks. Settings expose disk-friendly, balanced, and maximum profiles.
- Enriched inventory, duplicates, review queues, transfers, quarantine, scans,
  jobs, and reconciliation deltas use bounded pagination.
- Reconciliation materializes deltas in durable batches of at most 1,000 and
  maintains incremental counters, so pause/resume does not repeatedly count the
  entire work table.
- API collection limits are capped server-side even when a caller requests more.

The regression suite includes a 5,000-record baseline versus a 5,500-record
comparison producing 4,200 durable deltas, including forced pause/resume and
small-page retrieval. That is a correctness/scaling fixture, not a throughput
benchmark; actual speed depends primarily on filesystem latency and hashing
scope.

## Platform support and drive discovery

- **Windows:** fixed PowerShell/CIM logical-volume metadata query; drive type,
  label, filesystem, capacity, and free space are shown.
- **Linux:** fixed `findmnt` and `lsblk` metadata queries; mount identity,
  filesystem, capacity, read-only state, transport, and classification are
  shown.
- **macOS and other Node-supported systems:** use manual folder or mounted-volume
  enrollment.

Discovery commands accept no user-provided command text and inspect mount
metadata only. They do not walk or open volume contents. Manual enrollment is
available everywhere and always uses proposal-before-approval.

## WebUI and local API

The WebUI provides Dashboard, Libraries, Inventory, Analyze, Duplicates, Needs
Review, Ingest, Quarantine, Jobs, Scans, Organize/Activity, Safety, and Settings
views. Search and review tables are paginated and offer filters appropriate to
their evidence.

Primary API resources include:

- `/api/dashboard`, `/api/system`, `/api/safety`
- `/api/drives`, `/api/libraries`, `/api/enrollment/proposals`
- `/api/scans`, `/api/libraries/:id/inventory`,
  `/api/libraries/:id/search`, `/api/libraries/:id/analysis`
- `/api/duplicates`, `/api/needs-review`, `/api/semantic-groups`
- `/api/reconciliations`, `/api/reconciliations/:id/deltas`
- `/api/organization/plans`, `/api/organization/runs`,
  `/api/organization/audit`
- `/api/ingest/sources`, `/api/ingest/plans`, `/api/transfers`,
  `/api/quarantine`, `/api/transfer-audit`
- `/api/jobs`, `/api/worker`, `/api/settings/resources`

The production server allows only `127.0.0.1`, `::1`, or `localhost`; does
not enable CORS; rejects cross-origin state changes; accepts only GET/POST; caps
JSON requests at 64 KiB; applies a restrictive content security policy; and
validates identifiers, queries, enums, fields, and confirmation phrases. It has
no generic caller-selected filesystem read, write, delete, or arbitrary-job
route.

This is a single-user loopback application and has no login system. Do not
reverse-proxy or rebind it to a LAN or public interface.

## MCP status

The repository retains typed local facades and an architecture boundary for
future Model Context Protocol integration, but **registers no MCP tools and
starts no MCP transport**. The boundary intentionally fails closed until an
authentication model, deployment policy, and user-visible approval experience
are defined. The loopback WebUI/API is the supported application surface.

## Local application state and migrations

Default state locations:

| Platform | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\LocalLibrarian` |
| macOS | `$HOME/Library/Application Support/LocalLibrarian` |
| Linux/Unix | `$XDG_STATE_HOME/local-librarian` or `$HOME/.local/state/local-librarian` |

Use an explicit state directory for development or a portable instance:

```sh
npm run librarian -- --state /absolute/path/to/local-librarian-state
```

Alternatively set `LOCAL_LIBRARIAN_STATE_DIR`. State contains:

- `enrollments.jsonl` — append-only approvals, policy revisions, and revocations
- `inventory.sqlite` — scans, observations, content intelligence, settings,
  duplicate/review data, semantic groups, and reconciliations
- `jobs.sqlite` — jobs, attempts, leases, controls, checkpoints, and results
- `organization.sqlite` — mutation mode, plans, runs, receipts, and audit chain
- `transfers.sqlite` — ingest/cross-volume plans, item checkpoints, receipts,
  quarantine, and transfer audit
- `worker-status.json` — background worker heartbeat and process status

SQLite schemas migrate automatically inside transactions. A store constructor
closes its database handle if migration fails; it does not continue against a
partially migrated schema. Back up state with the libraries it describes when
historical receipts matter, and review path metadata before sharing a state
directory in a bug report.

## Development and command-line tools

```sh
npm run check          # Type-check server and WebUI
npm test               # Run the test suite once
npm run build          # Build dist/ and web-dist/
npm run verify         # Check, test, and build
npm run test:watch     # Run Vitest in watch mode
npm run web            # Start an already-built WebUI/server
npm run worker:local -- <state-directory> [--once]
```

Built metadata-oriented CLI tools remain available:

```sh
npm run roots:enroll -- <state-directory> <root-path> <display-name>
npm run inventory -- <submit|summary|list|get|status|result|history|pause|resume|cancel> <state-directory> <id> [arguments]
npm run reconcile -- <state-directory> <root-id> <baseline-scan-id> <comparison-scan-id>
```

The WebUI is the supported turnkey workflow. CLI tools emit structured JSON and
expect production bundles to have already been built.

## Architecture

```text
Browser on loopback
  -> fixed, validated local API
      -> enrollment journal
      -> inventory + intelligence catalog
      -> organization + transfer plans and receipts
      -> durable job queue
            -> independent local worker
                -> root/identity and mutation-policy guards
                -> canonical path/filesystem guards
                -> bounded scanner, analyzers, reconciler, or executor
```

The browser never performs filesystem traversal or canonicalization. Planning
and approval are separate from execution, and the worker independently repeats
authority, identity, path, source-state, capacity, and collision checks.

```text
src/catalog/         SQLite inventory sessions and paginated queries
src/cli/             State resolution and local command-line entry points
src/domain/          Immutable shared contracts and branded identifiers
src/enrollment/      Root inspection, identity, approval, policy, journal
src/intelligence/    Hashing, analyzers, classification, duplicates, relationships, reconciliation
src/jobs/            Durable queue, leases, controls, recovery, heartbeat
src/organization/    Planning, same-volume execution, rollback, audit
src/safety/          Canonicalization and root/path authorization
src/scanner/         Metadata traversal and inventory job
src/transfer/        Ingest, verified copy, cross-volume work, quarantine, restore
src/web/             Loopback server, fixed API, runtime composition
web/src/             React WebUI
test/                Unit, integration, migration, recovery, safety, and Web/API tests
```

## Current boundaries

Local Librarian 2.0 does not:

- permanently delete files or directories;
- continuously watch enrolled roots;
- fully parse every document, media, or archive format;
- infer remotely or contact a cloud service;
- expose an enabled MCP server or arbitrary filesystem API;
- automatically discover macOS volumes;
- execute transfer-plan items concurrently within one local worker (the persisted
  transfer-concurrency field is reserved for a future scheduler);
- eliminate the final filesystem race against another privileged process acting
  between validation and the operating-system operation.

Optional `ffprobe` and optional loopback model services are enhancements, not
requirements. Failures or absence degrade to bounded built-in evidence and
Needs Review rather than silently granting mutation authority.

See [CHANGELOG.md](CHANGELOG.md) for the V2 release summary.
