---
"@pokapali/sync": patch
"@pokapali/core": patch
---

Fix data channel timing, binaryType, and continuous reconciliation

Fire onPeerConnection at PC creation (not "connected" state)
so consumers can register datachannel listeners before events
fire. Set binaryType to "arraybuffer" on all data channels.
Re-trigger reconciliation on local edits (debounced 100ms)
so new edits propagate to connected peers. Add P2P diagnostic
logging for data channel lifecycle and reconciliation start.
