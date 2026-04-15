---
"@pokapali/sync": minor
"@pokapali/core": patch
---

Add onNeedsSwap to AwarenessRoom for dead room recovery

AwarenessRoom now exposes onNeedsSwap(cb), which fires
when the signaling stream closes AND all WebRTC peers
disconnect. Consumers use this to proactively
re-establish signaling rather than waiting for a relay
reconnect event that may never arrive.

requestReconnect routes through the concurrency gate
(attemptSignaling) so it serializes with relay reconnect
events.
