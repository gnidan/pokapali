---
"@pokapali/core": minor
---

A3: unified ingestSnapshot single-ingress path

- New `createIngestSnapshot` orchestrator: CID integrity,
  signature validation, duplicate detection, structural
  placement (isPlaceable), sideband quarantine with FIFO
  eviction, rescanPending() for deferred placements
- Refactored snapshot-ops.ts to thin interpreter shim
  delegating to ingest orchestrator (Option Y source
  dispatch via lastLocalPublishCid flag)
- PendingIngestError for interpreter tip-skip on
  unplaceable-epoch snapshots
- onReconcileCycleEnd hook in reconciliation-wiring for
  rescan trigger after peer-edit arrivals
- onIngestOutcome callback for D3 diagnostics (consumer
  deferred)
