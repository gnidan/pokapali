# @pokapali/sync

```sh
npm install @pokapali/sync
```

WebRTC room setup for real-time Yjs sync. Creates one
y-webrtc room per writable channel (password-protected
with the channel access key) and a shared awareness room
for cursor presence. Signaling is handled via a GossipSub
adapter over the libp2p mesh — no external WebSocket
signaling servers required.

## Key Exports

- **`setupNamespaceRooms()`** — creates WebrtcProvider
  instances for each writable channel
- **`setupAwarenessRoom()`** — creates the shared
  awareness room (all capability levels join)
- **`createGossipSubSignaling()`** — GossipSub-based
  signaling adapter that registers in y-webrtc's
  `signalingConns` map
- **`SyncManager`** — interface for connection status,
  cleanup, and `onStatusChange(cb)` for reacting to
  y-webrtc provider status events (e.g. after PBKDF2
  key derivation completes)
- **`SyncOptions`** — configuration (ICE servers, peer
  options)
- **`PubSubLike`** — minimal pubsub interface for
  GossipSub integration

## Links

- [Root README](https://github.com/gnidan/pokapali#readme)
- [Architecture](https://github.com/gnidan/pokapali/tree/main/docs/internals)
