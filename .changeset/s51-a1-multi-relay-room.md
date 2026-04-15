---
"@pokapali/sync": minor
---

Add MultiRelayRoom for multi-relay awareness

New createMultiRelayRoom wraps N per-relay
AwarenessRooms behind a single AwarenessRoom
interface. Aggregates connection status, forwards
peer events, and auto-removes dead sub-rooms via
onNeedsSwap. Management API (addRelay/removeRelay)
is separate from AwarenessRoom — only used by
index.ts wiring.
