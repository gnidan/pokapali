---
"@pokapali/sync": patch
"@pokapali/core": patch
"@pokapali/document": patch
"@pokapali/capability": patch
---

Fix multi-peer sync and signaling retry.

- Add onPeerCreated to AwarenessRoom interface for
  pre-SDP data channel creation
- Add Document.onEdit() for multiple edit listeners
- Strip query params from capability URL path parsing
- Live edit forwarding via EDIT_BATCH messages
- Signaling retry when initial relay timeout expires
- Create reconciliation DC in onPeerCreated (before
  SDP offer) instead of onPeerConnection
