---
"@pokapali/node": patch
---

#376 Fix stale-resolve pruning to deactivate instead of delete, honoring 14-day retention window. Adds startup grace period to prevent mass-pruning on restart.
