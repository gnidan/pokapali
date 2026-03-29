---
"@pokapali/sync": patch
"@pokapali/core": patch
---

Strip y-webrtc per-channel sync; reconciliation is
now the only document data sync path.

- setupNamespaceRooms() is now a thin no-op shell
  (no WebrtcProviders created per channel)
- onPeerConnection moved from SyncManager to
  AwarenessRoom (awareness provider is the sole
  source of RTCPeerConnection lifecycle)
- connectChannel() removed from create-doc.ts
  call sites (now a no-op on SyncManager)
- Awareness room still uses y-webrtc for signaling
  and peer discovery
