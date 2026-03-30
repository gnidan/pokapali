---
"@pokapali/sync": patch
---

Fix duplicate PEER_JOINED and ICE error handler wiring

Deduplicate PEER_JOINED events per peer (caused by multi-relay
forwarding) to prevent duplicate SDP offers that corrupt
negotiation. Fix ICE error handler to use addEventListener
instead of property assignment.
