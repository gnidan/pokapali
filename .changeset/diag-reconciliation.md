---
"@pokapali/sync": patch
"@pokapali/core": patch
---

Fix data channel timing and binaryType for reconciliation

Fire onPeerConnection at PC creation (not "connected" state)
so consumers can register datachannel listeners before events
fire. Set binaryType to "arraybuffer" on all data channels.
Add P2P diagnostic logging for data channel lifecycle and
reconciliation start.
