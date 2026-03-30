---
"@pokapali/core": patch
---

Fix signaling race: wait for relay discovery before
opening signaling stream

The signaling setup code iterated relayPeerIds
immediately after startRoomDiscovery(), but discovery
runs asynchronously. The set was always empty, so the
signaling path never executed, and the y-webrtc
fallback had no GossipSub adapter (removed in !341)
and no signaling URLs — resulting in zero peer
discovery.

Adds waitForRelay(timeoutMs) to RoomDiscovery so the
signaling setup properly waits for a relay to connect
before attempting the protocol dial.
