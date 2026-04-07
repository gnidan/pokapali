---
"@pokapali/sync": patch
"@pokapali/node": patch
---

Fix WebRTC signaling reconnection: replace stale
peer connections instead of silently ignoring
reconnect attempts, fire onPeerConnection callbacks
on connected state, and reset connection status
when all peers disconnect. Fix relay registry race
where old stream cleanup removes new stream's
registration on reconnect.
