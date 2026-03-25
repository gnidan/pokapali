---
"@pokapali/core": minor
---

Move subdocs management into core as Subdocs
companion object (Subdocs.create,
Subdocs.SNAPSHOT_ORIGIN). Core no longer depends
on @pokapali/subdocs. The subdocs package remains
unchanged for external consumers (sync).
