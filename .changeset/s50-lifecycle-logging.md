---
"@pokapali/core": patch
"@pokapali/sync": patch
"@pokapali/node": patch
---

Add P2P lifecycle logging and concurrency gate

Upgrade diagnostic logs from debug to info across
signaling, relay forwarding, and awareness room
lifecycle. Add concurrency gate with latest-wins
semantics for relay reconnect signaling attempts.
