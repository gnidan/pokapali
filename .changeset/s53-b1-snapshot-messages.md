---
"@pokapali/sync": minor
---

Add snapshot exchange message types (reconciliation
channel types 6/7/8): SNAPSHOT_CATALOG,
SNAPSHOT_REQUEST, SNAPSHOT_BLOCK. Per-document (no
channel field). SNAPSHOT_BLOCK carries offset/total
for ~200KB chunking; empty block with total=0
signals NAK.
