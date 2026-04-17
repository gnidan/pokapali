---
"@pokapali/example": patch
---

Add Path A snapshot-exchange diagnostics panel to the
example app's `ConnectionStatus`. Dev-only
(`import.meta.env.DEV` + `?diag` URL param), bounded
20-event ring buffer, newest-first chronological
event log of:

- `catalog` advertisements from `doc.catalogEvents`
  (architect-pinned feed, feature-detected until A4
  lands the wiring).
- `BLK (local)` / `BLK (remote)` from the existing
  `doc.snapshotEvents`, using `SnapshotEvent.isLocal`
  to distinguish author activity from peer-delivered
  snapshots.

Zero new core work for S54. Peer attribution and
valid/invalid markers on BLK rows were briefly
upgraded ("Tier 0.5" via a new `blockReceivedEvents`
feed) then withdrawn on kaizen grounds; deferred to
S55+ with shape-ratification concerns filed. Path A
ships forward-compatible `data-kind` testing-hook
vocabulary for all S55+ kinds, plus a Path-A-
specific `data-locality` sub-discriminator on `blk`
rows (`local`/`remote`).
