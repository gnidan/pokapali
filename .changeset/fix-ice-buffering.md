---
"@pokapali/sync": patch
---

Fix WebRTC ICE candidate race by buffering until remote description set

ICE candidates arriving before setRemoteDescription were silently
dropped, causing connections to hang at "connecting". Candidates
are now buffered per-peer and flushed after setRemoteDescription
completes.
