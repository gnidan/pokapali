---
"@pokapali/core": patch
---

Rewrite relay wiring to use MultiRelayRoom with
addRelay/removeRelay instead of single-relay swap logic.
Relays are now managed dynamically — initial relay connects
via waitForRelay, subsequent relays via onRelayReconnected.
Dead relays are auto-removed by MultiRelayRoom's onNeedsSwap.
