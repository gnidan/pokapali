# @pokapali/sync

## 0.1.2

### Patch Changes

- [#55](https://github.com/gnidan/pokapali/issues/55)
  [`914d7e7`](https://github.com/gnidan/pokapali/commit/914d7e74c801467b6350dcc2e86d2f4a5ee27c5a)
  Pause periodic timers when browser tab is hidden.

  Adds `createThrottledInterval`, a visibility-aware
  `setInterval` wrapper that pauses (or throttles) when
  the tab is backgrounded and optionally fires
  immediately on resume.

  Integrated into topology-sharing, relay-sharing,
  node-registry, peer-discovery, and gossipsub-signaling
  to eliminate unnecessary background CPU, network, and
  battery usage.

- [`ce4bc52`](https://github.com/gnidan/pokapali/commit/ce4bc5278048901043a4857a4799a10bd6cd62a5)
  Remove dependency on patched y-webrtc internal exports.

  Replaces import of y-webrtc-internals.js (which relied
  on patch-package to expose signalingConns and
  setupSignalingHandlers) with a self-contained
  monkey-patch of WebrtcProvider.connect() and inline
  signal routing. Eliminates the need for patch-package
  in the sync package.
