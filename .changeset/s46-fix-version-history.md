---
"@pokapali/core": patch
---

Fix version history not loading from cached snapshots.
Migrated snapshots were pushed as cid-discovered facts
but never populated snapshotHistory (which only reads
snapshot-materialized facts). Now hydrate version cache
also populates localSnapshotHistory and triggers
updateVersionsFeed().
