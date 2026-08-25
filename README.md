# Local Librarian

Local Librarian 1.0 is a local-first application for turning messy folders and
drives into reviewable, organized libraries. It inventories filesystem metadata,
builds deterministic move plans, tests those plans without mutation, applies
approved relocations, and can roll successful moves back.

No cloud account or hosted service is required. The WebUI binds only to the
local computer, application state stays local, and inventory scans do not open
or hash file contents.

> Live mode moves real files. Review every plan and keep normal backups of
> important data. Local Librarian never overwrites an existing destination and
> v1 never permanently deletes files.

## Quick start

Prerequisites:

- Node.js 22.5 or newer
- npm

```sh
npm install
npm start
```

Open [http://localhost:4777](http://localhost:4777). `npm start` builds the
server and WebUI, starts the loopback-only application, and ensures the durable
background worker is running. The worker is independent so submitted work can
survive a browser or WebUI restart.

For a release-quality local verification:

```sh
npm run verify
```

That command type-checks the server and WebUI, runs the complete test suite, and
builds both production bundles.

## The intended workflow

1. Open **Libraries**, choose an existing folder or drive, and inspect its
   canonical path and volume identity.
2. Explicitly approve the proposal. New libraries always begin read-only.
3. Open **Inventory** and run a metadata scan.
4. Open **Organize**, select a policy, and build a plan from the latest completed
   scan.
5. Review every proposed source, destination, reason, and represented size.
6. Run **Test safely**. Simulation repeats current filesystem safety checks but
   creates no directories and moves no files.
7. To apply the plan, enable both live-safety interlocks, type the plan-specific
   confirmation phrase, and monitor its durable run receipts.

If a successful move needs to be undone, use **Roll back** from its live run.
Rollback is also safety-gated and restores eligible files in reverse order.

## Organization policies

Plans are deterministic snapshots tied to one completed inventory and one
enrolled root identity.

| Setting | Choices | Default |
| --- | --- | --- |
| Structure | category; category then year; year then month | category then year |
| Scope | loose top-level files; all files | loose top-level files |
| Destination | any safe root-relative folder | `Organized` |
| Collisions | keep both with a numeric suffix; skip | keep both |
| Hidden files | include or exclude | exclude |
| Maximum moves | 1–50,000 | 10,000 |

Top-level scope deliberately preserves existing folders because their grouping
may already be meaningful. All-files scope can relocate nested files into the
new structure; it does not delete the directories they leave behind.

Category planning recognizes common Documents, Spreadsheets, Images, Videos,
Audio, Archives, Books, Fonts, Code, Data, Applications, and Design formats.
Unknown extensions and extensionless files go to `Other`. Date structures use
the observed modified time, then created time, and fall back to `Unknown year`
or `Unknown month` when no usable date exists.

The planner excludes Local Librarian's reserved control area, rejects traversal
and absolute targets, prevents destination duplication within a plan, checks
the scan catalog for existing destinations, and records source size, modified
time, filesystem device, and record identity for execution-time validation.

## Read-only and live modes

The global mutation mode is persisted in `organization.sqlite` and defaults to
`read-only` on a fresh state directory.

### Read-only testing

- Enrollment inspection and inventory are available.
- Plans and scan comparisons are available.
- Full organization and rollback simulations are available.
- No organization directory is created and no file is moved.

### Live mutation

Live execution requires both independent interlocks:

1. Global mode is **Live file mutation**.
2. The specific enrolled library has **Writes explicitly approved**.

Enabling one does not enable the other. A live run additionally requires the
exact phrase `APPLY N FILE MOVES`; live rollback requires
`ROLL BACK N FILE MOVES`. Returning global mode to read-only uses `DISABLE` and
takes effect at the next per-file safety boundary.

The **Safety & diagnostics** page controls both interlocks, shows the worker and
runtime state, verifies the organization audit chain, and lists all application
state paths.

## Filesystem safety contract

Every live operation rechecks safety when the worker executes it; approval at
plan time is not treated as permanent authority.

- The library must still be approved and match its durable root/volume identity.
- Global live mode and library write approval are checked before every move and
  again immediately before rename.
- Source and destination must remain inside the canonical enrolled root.
- Parent traversal, absolute paths, Windows drive/ADS syntax, symlinks,
  junctions, reparse points, and filesystem-boundary crossings are rejected.
- The source must still be a regular file with the recorded size, modified time,
  device, and filesystem record identity.
- The destination must not exist. Local Librarian never asks the operating
  system to overwrite it.
- Missing destination folders are created one component at a time and inspected
  after creation.
- The final move uses a same-filesystem atomic rename and is verified afterward.

An item whose preconditions changed is skipped or failed with a per-file receipt;
other independent items may continue. The run is marked `partial` when any item
was skipped or failed. Durable checkpoints make retries idempotent: if a crash
happened after rename, the worker recognizes the already-completed filesystem
state rather than moving the file twice.

Rollback includes only files recorded as successfully moved. It validates the
organized file against the original facts and restores it only if the original
path is free. It never deletes the organizational directories it leaves empty.

## Product features

### Dashboard

Shows libraries, latest scans, saved plans, recent organization runs, durable
jobs, worker state, active work, and failures needing attention.

### Libraries

- Read-only Windows logical-volume discovery
- Manual folder enrollment on supported platforms
- Proposal-before-approval workflow
- Canonical path, volume, and filesystem identity review
- Explicit revocation
- Separate per-library write approval

Enrollment paths must already exist and be directories. Approval re-inspects the
path and rejects it if identity changed after proposal.

### Inventory

- Resumable, metadata-only traversal
- Bounded batches and durable scan frontiers
- File, directory, represented-byte, skip, and error counts
- Search plus type and extension filters
- Cursor pagination and retained scan snapshots
- Cooperative pause, resume, and cancellation
- Safe restart from durable checkpoints

The scanner does not follow symbolic links, stays on the enrolled filesystem,
and ignores the `.local-librarian` control directory.

### Scan history and comparison

Scan sessions are immutable and retained. Select a library and two completed
scans to generate a read-only reconciliation report of added, missing, and
metadata-changed paths. Comparison reads only the local inventory catalog.

### Organize

- Policy builder with conservative defaults
- Saved, reviewable plan snapshots
- Exact move preview and rationale
- Read-only execution testing
- Safety-gated live relocation
- Durable progress, per-file outcomes, and run history
- Safety-gated reverse-order rollback

### Jobs

The SQLite queue provides idempotent submission, priorities, exclusive leases,
attempt history, heartbeat renewal, checkpoints, retries, cooperative controls,
and structured results. The WebUI submits only fixed supported job kinds; it
does not expose an arbitrary job or filesystem endpoint.

### Audit

Mode changes, plans, runs, operation outcomes, failures, and rollbacks append to
a SHA-256 hash chain. SQLite triggers reject audit-row updates and deletes, and
the Safety page verifies sequence and hash integrity. Enrollment policy changes
are separately retained in the append-only enrollment journal.

## Local application state

Default state locations:

| Platform | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\LocalLibrarian` |
| macOS | `$HOME/Library/Application Support/LocalLibrarian` |
| Linux/Unix | `$XDG_STATE_HOME/local-librarian` or `$HOME/.local/state/local-librarian` |

Use an explicit directory for development or a portable test instance:

```sh
npm run librarian -- --state /absolute/path/to/local-librarian-state
```

Or set `LOCAL_LIBRARIAN_STATE_DIR`. The state directory contains:

- `enrollments.jsonl` — append-only root approvals, policy revisions, and revocations
- `inventory.sqlite` — scan sessions, traversal frontiers, and observations
- `jobs.sqlite` — queue state, attempts, history, checkpoints, and results
- `organization.sqlite` — mutation mode, plans, operations, runs, receipts, and audit
- `worker-status.json` — local worker heartbeat/status

Treat this directory as private. Do not attach it to bug reports without
reviewing paths and metadata first. Back it up with the data it describes when
you need durable historical receipts.

## Local WebUI and API security

The production server accepts only `127.0.0.1`, `::1`, or `localhost` bindings;
the standard entry point uses `127.0.0.1`. It sets a restrictive content
security policy, does not enable CORS, rejects cross-origin state changes,
accepts only GET/POST, caps JSON bodies at 64 KiB, and validates route IDs,
queries, enums, fields, and confirmation phrases.

Because this is a single-user loopback application, v1 has no login system. Do
not proxy or rebind it onto a LAN or public interface.

Primary API resources are:

- `/api/dashboard`, `/api/system`, `/api/safety`
- `/api/drives`, `/api/libraries`, `/api/enrollment/proposals`
- `/api/scans`, `/api/inventory`, `/api/reconciliation`
- `/api/organization/plans`, `/api/organization/runs`, `/api/organization/audit`
- `/api/jobs`, `/api/worker`

There is no generic path-read, path-write, delete, or caller-selected-job route.

## Development and command-line tools

```sh
npm run check          # Type-check server and WebUI
npm test               # Run all tests once
npm run build          # Build dist/ and web-dist/
npm run verify         # Check, test, then build
npm run test:watch     # Watch tests while developing
npm run web            # Run an already-built WebUI/server
npm run worker:local -- <state-directory> [--once]
```

The built metadata utilities remain available for diagnostics and automation:

```sh
npm run roots:enroll -- <state-directory> <root-path> <display-name>
npm run inventory -- <submit|summary|list|get|status|result|history|pause|resume|cancel> <state-directory> <id> [arguments]
npm run reconcile -- <state-directory> <root-id> <baseline-scan-id> <comparison-scan-id>
```

The WebUI is the supported turnkey workflow; the CLI utilities print structured
JSON and assume the production bundles have already been built.

## Architecture

```text
Browser on loopback
  -> fixed local API
      -> enrollment journal
      -> inventory catalog
      -> organization plans, receipts, and audit
      -> durable job queue
            -> independent local worker
                -> root/identity guard
                -> canonical path and filesystem guard
                -> metadata scanner or atomic relocation executor
```

The browser never performs filesystem traversal or canonicalization. Planning
is separate from execution, and the worker independently repeats enrollment,
identity, policy, path, metadata, and collision checks.

Source layout:

```text
src/domain/          Immutable shared contracts and branded IDs
src/enrollment/      Root inspection, identity, approval, policy, journal
src/scanner/         Metadata traversal and inventory job
src/catalog/         SQLite inventory sessions and queries
src/reconciliation/ Read-only snapshot comparison
src/organization/   Categorization, planning, execution, rollback, audit
src/jobs/            Durable queue, controls, leasing, recovery, heartbeat
src/safety/          Canonicalization and root/path authorization
src/web/             Loopback server, fixed API, runtime composition
web/src/             React application
test/                Unit, integration, recovery, safety, and Web/API tests
```

## Version 1 boundaries

Version 1 deliberately supports organization by relocation within one enrolled
library. It does not currently:

- copy files between drives or ingest removable media;
- permanently delete files or directories;
- read or hash file contents;
- detect content duplicates;
- classify using file contents, EXIF, or media analysis;
- watch folders continuously;
- expose an MCP transport or callable MCP server;
- eliminate filesystem races created by another privileged process acting in
  the instant between validation and the operating-system rename.

The repository contains domain ports for some future ingest, analysis, MCP, and
executor capabilities, but they are not presented as working v1 features. The
implemented v1 path is enrollment → inventory → comparison/planning → simulation
→ gated relocation → receipts/rollback.

## Troubleshooting

- **A plan cannot be built:** approve the library and finish a new inventory
  scan. The latest completed scan must match the current root identity.
- **Apply is disabled:** enable global live mode and write approval for that
  library on Safety & diagnostics.
- **A move was skipped:** inspect the run receipt. Common causes are a changed
  source, a new destination collision, or a non-regular file.
- **The worker is offline/stale:** use **Start local worker** on Safety. Startup
  also retries it automatically.
- **A root moved or was remounted:** create a fresh proposal so its canonical
  path and durable volume identity can be revalidated.
- **The UI says it is not built:** run `npm run build`, then `npm run web`, or use
  `npm start` to build and launch in one command.
