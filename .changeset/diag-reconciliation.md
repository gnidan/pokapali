---
"@pokapali/sync": patch
"@pokapali/core": patch
---

Fix data channel timing, binaryType, continuous reconciliation,
and awareness cleanup

Fire onPeerConnection at PC creation (not "connected" state)
so consumers can register datachannel listeners before events
fire. Set binaryType to "arraybuffer" on all data channels.
Re-trigger reconciliation on local edits (debounced 100ms)
so new edits propagate to connected peers. Remove remote
peer awareness states on data channel close. Add P2P
diagnostic logging for transport send/receive,
reconciliation triggers, and data channel lifecycle.
