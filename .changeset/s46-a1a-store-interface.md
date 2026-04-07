---
"@pokapali/store": minor
---

Unified Store interface with single `pokapali:{appId}`
IDB database. Six object stores: identities, edits,
epochs, snapshots, view-cache, meta. Hierarchical API:
Store.Identity for device keys, Store.Documents for
lazy per-document handles with History, Snapshots, and
ViewCache sub-interfaces. Replaces the old split-DB
approach (separate edit/epoch and view-cache databases).
