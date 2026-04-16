---
"@pokapali/example": patch
---

Fix `lastPublished` timestamp regression for late
joiners post-S54. Replace `setLastPublished(Date.now())`
with latest-publish-wins semantics
(`Math.max(prev, event.ts)`) so historical snapshots
delivered out-of-order from a peer don't overwrite the
"last updated" display with stale "just now" values.
Adds a small `nextPublishedTs` helper with unit tests
covering newer/older/equal cases.
