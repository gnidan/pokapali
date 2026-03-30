---
"@pokapali/sync": patch
---

Fix WebRTC connection establishment

Deduplicate PEER_JOINED events per peer (caused by multi-relay
forwarding) to prevent duplicate SDP offers that corrupt
negotiation. Fix ICE error handler to use addEventListener
instead of property assignment. Create a data channel before
SDP offer so ICE negotiation actually starts.
