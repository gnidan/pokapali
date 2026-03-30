---
"@pokapali/node": patch
"@pokapali/test-utils": patch
"@pokapali/core": patch
---

Add relay-to-relay signaling forwarding via GossipSub

Relays now forward JOIN/LEAVE/SIGNAL messages to each other
through the `/pokapali/signaling/relay` GossipSub topic so
browsers connected to different relays can discover peers.
Also adds P2P diagnostic logging and wires the signaling
protocol handler into the test relay.
