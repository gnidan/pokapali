---
"@pokapali/node": patch
"@pokapali/sync": patch
---

Wire signaling protocol handler into relay and
remove GossipSub signaling adapter

Registers /pokapali/signaling/1.0.0 stream handler
on the relay's libp2p node so browser clients can
dial it for peer discovery and WebRTC negotiation.

Deletes gossipsub-signaling.ts and removes the
GossipSub adapter wiring from setupAwarenessRoom.
Removes SIGNALING_TOPIC pubsub subscription (replaced
by the dedicated stream protocol).
