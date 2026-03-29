---
"@pokapali/sync": patch
"@pokapali/core": patch
---

Wire reconciliation coordinator + transport into
create-doc.ts for per-peer edit exchange.

- Export reconciliation types from @pokapali/sync barrel
- Add SyncManager.onPeerConnection hook for data channel
  creation on new WebRTC peer connections
- reconciliation-wiring.ts: connects coordinators to
  transport per channel with FULL_STATE snapshot support
- create-doc.ts: wire reconciliation on peer connect,
  trigger on datachannel open, cleanup on close/destroy
