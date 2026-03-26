---
"@pokapali/core": patch
---

Add epoch fact types, EpochState reducer, and projectFeed

New fact types: epoch-closed, convergence-detected,
snapshot-materialized, edit-received, edit-verified,
view-cache-loaded, view-cache-written. EpochState
reducer tracks per-channel epoch counts, convergence
hashes, dirty flags, and view cache staleness.
projectFeed derives focused reactive feeds from
broader source feeds with equality-based dedup.
