---
"@pokapali/core": patch
"@pokapali/store": patch
---

Add epoch interpreter effects and view cache store

Interpreter reacts to epoch lifecycle facts:
convergence-detected dispatches epoch-closed,
epoch-closed triggers snapshot materialization and
view cache writes, snapshot-materialized announces
via gossip, view-cache-loaded populates caches.
ViewCacheStore provides IDB persistence for
serialized monoid results keyed by
(viewName, channel, epochOrdinal).
