---
"@pokapali/core": patch
---

Add SnapshotHistory types, reducer, and derive function
for epoch-based version tracking. Add `seq` field to
snapshot-materialized fact. Coexists with ChainState-
based deriveVersionHistory during transition.
