---
"@pokapali/node": patch
---

#376 Fix startup stale-resolve mass deletion.

Add STARTUP_GRACE_MS (10 minutes) that skips
stale-resolve pruning immediately after pinner
start. On restart, lastResolvedAt is stale because
resolveAll() runs async — without this grace, every
doc looks stale and gets deleted.

Also adds periodic pruning (hourly) so stale-resolve
still fires after the grace window expires. Previously
pruneIfNeeded() only ran at startup.
