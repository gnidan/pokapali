---
"@pokapali/core": minor
---

Auto-recreate signaling stream after relay
reconnection. When a relay redials successfully,
open a new signaling stream, create a new
SignalingClient, and re-join awareness rooms so
WebRTC peer connections recover automatically.
