---
"@pokapali/sync": patch
"@pokapali/core": patch
---

Remove y-webrtc dependency from @pokapali/sync.
setupAwarenessRoom (y-webrtc-based) replaced by
setupSignaledAwarenessRoom in all call sites.
doc-rotate now uses a placeholder awareness room
instead of the removed y-webrtc-based function.
