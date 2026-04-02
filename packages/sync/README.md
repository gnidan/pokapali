# @pokapali/sync

```sh
npm install @pokapali/sync
```

WebRTC room setup for real-time Yjs sync and
awareness. Awareness is synced over dedicated WebRTC
data channels using y-protocols/awareness. Peer
discovery and SDP/ICE exchange use a dedicated
signaling protocol routed through relay nodes.

## Key Exports

- **`setupNamespaceRooms()`** — creates a SyncManager
  shell (document data sync is handled by
  reconciliation)
- **`setupSignaledAwarenessRoom()`** — creates a
  shared awareness room using the signaling protocol
  for WebRTC peer discovery
- **`createSignalingClient()`** — creates a signaling
  client from a libp2p stream to a relay node
- **`SyncManager`** — interface for connection status
  and cleanup
- **`AwarenessRoom`** — interface for awareness sync,
  peer connection hooks, and status tracking
- **`SyncOptions`** — configuration (ICE servers, peer
  options)
- **`PubSubLike`** — minimal pubsub interface for
  GossipSub integration

## Links

- [Root README](https://github.com/gnidan/pokapali#readme)
- [Architecture](https://github.com/gnidan/pokapali/tree/main/docs/internals)
