---
"@pokapali/core": patch
"@pokapali/sync": patch
---

Replace y-webrtc WebrtcProvider awareness with direct
WebRTC awareness sync using the signaling protocol.
Removes the `setupAwarenessRoom` function and
y-webrtc import from `@pokapali/sync`. The
`setupSignaledAwarenessRoom` function (using dedicated
signaling via relay nodes) is now the sole awareness
room implementation.
