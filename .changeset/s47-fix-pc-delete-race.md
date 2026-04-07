---
"@pokapali/sync": patch
---

Guard peers.delete in onconnectionstatechange to
only delete if the map entry is still the same PC,
preventing an old PC's deferred callback from
removing a newer replacement.
