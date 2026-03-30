---
"@pokapali/sync": patch
"@pokapali/core": patch
---

Add signaling-based awareness room with WebRTC
peer connections and wire into core

Adds peer-connection manager (raw WebRTC,
deterministic initiator via lexicographic peerId),
awareness sync over dedicated RTCDataChannel, and
setupSignaledAwarenessRoom. Core's p2pReady now
tries the signaling protocol with connected relays
before falling back to GossipSub-based awareness.
