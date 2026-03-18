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

## Usage

```typescript
import {
  setupNamespaceRooms,
  setupAwarenessRoom,
  createGossipSubSignaling,
} from "@pokapali/sync";

// 1. Set up per-channel WebRTC sync rooms
const syncManager = setupNamespaceRooms(
  ipnsName,
  subdocManager,
  { content: channelKey }, // channel name → key
  signalingUrls,
);

// Monitor connection status
syncManager.onStatusChange((status) => {
  console.log(status); // "connecting" | "connected" | "disconnected"
});

// Connect additional channels on demand
syncManager.connectChannel("comments");

// 2. Set up shared awareness room for cursors
const { awareness, destroy: destroyAwareness } = setupAwarenessRoom(
  ipnsName,
  awarenessPassword,
  signalingUrls,
);

// 3. Use GossipSub for P2P signaling (no WebSocket
//    signaling server needed)
const signaling = createGossipSubSignaling(pubsub);

// Pass pubsub via SyncOptions to enable it
const syncWithGossip = setupNamespaceRooms(
  ipnsName,
  subdocManager,
  { content: channelKey },
  [], // no WebSocket signaling URLs needed
  { pubsub },
);

// Clean up
syncManager.destroy();
destroyAwareness();
```

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

- [Root README](../../README.md)
- [Architecture](../../docs/internals/)
