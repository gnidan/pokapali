---
"@pokapali/sync": patch
---

Remove dependency on patched y-webrtc internal exports.

Replaces import of y-webrtc-internals.js (which relied
on patch-package to expose signalingConns and
setupSignalingHandlers) with a self-contained
monkey-patch of WebrtcProvider.connect() and inline
signal routing. Eliminates the need for patch-package
in the sync package.
