# Changelog

All notable changes to Local Librarian are documented here. The project follows
semantic versioning for its application and persisted-schema releases.

## 2.0.0 - 2026-08-26

### Added

- Progressive, restartable analysis stages for duplicate candidates, SHA-256
  content identity, local metadata, deterministic classification, and related
  file/project grouping.
- Candidate and byte-for-byte duplicate review with durable keeper decisions and
  quarantine-backed consolidation.
- Paginated, filterable enriched inventory and a durable Needs Review workflow.
- Persisted, resumable reconciliation jobs with paginated added, missing, and
  metadata-changed deltas suitable for large catalogs.
- Removable-source ingest and verified cross-volume organization using staged
  copies, capacity checks, SHA-256 verification, atomic promotion, receipts,
  quarantine, and restore.
- Resource controls for hashing, metadata analysis, transfer chunking, and an
  optional loopback-only local classifier.
- Windows and Linux read-only volume discovery, plus manual enrollment on every
  supported platform.
- Dedicated Analyze, Duplicates, Needs Review, Ingest, Quarantine, Settings, and
  scalable scan-comparison views in the local WebUI.

### Changed

- Organization planning can preserve coherent projects and related groups, and
  ambiguous files are excluded until reviewed.
- Inventory observations include platform file identity attributes used by
  mutation-time stale-source checks.
- Runtime composition, worker handlers, local state paths, API resources, and
  dashboards now expose the V2 workflow.

### Safety

- Mutation still defaults to read-only and requires both global and per-library
  write approval.
- Transfers never overwrite a destination. They revalidate roots and source
  identity, stage on the destination volume, verify content, promote atomically,
  and quarantine source files instead of deleting them.
- Migration failures close database handles without leaving partially usable
  stores, and resumable operations are covered at crash boundaries.

### Known limitations

- There is no permanent-delete workflow, continuous filesystem watcher, or
  enabled MCP transport.
- Metadata extraction is deliberately bounded and format-specific; `ffprobe`
  is optional for richer audio/video facts.
- Automatic volume discovery is implemented for Windows and Linux. macOS uses
  manual folder or mounted-volume enrollment.

## 1.0.0

- Initial local-first inventory, scan comparison, deterministic organization,
  safety-gated same-volume relocation, rollback, durable jobs, and WebUI.
