# @pokapali/core

## 0.1.3

### Patch Changes

- [#15](https://github.com/gnidan/pokapali/issues/15)
  [`e122e88`](https://github.com/gnidan/pokapali/commit/e122e8850223f45a4b8d5474856533a113ac8716)
  Add chain block prefetching after tip-advanced

  After the tip advances, the interpreter now walks `prev` links
  and dispatches fetches for up to `prefetchDepth` (default 3)
  parent blocks. This catches pinner-index and cache-sourced
  entries that the normal auto-fetch policy skips, reducing
  sequential fetch latency during chain walks.

  Set `prefetchDepth: 0` in DocParams to disable.

- [#40](https://github.com/gnidan/pokapali/issues/40)
  [`fcebbcb`](https://github.com/gnidan/pokapali/commit/fcebbcb5f43d27bf539d41b8be9cad3ff513d3c5)
  Tune fetch retry backoff from 10s/30s/90s to
  2s/8s/32s for faster recovery from transient network
  failures.
- [#289](https://github.com/gnidan/pokapali/issues/289)
  [`9f5fd77`](https://github.com/gnidan/pokapali/commit/9f5fd77d715fcb9f05cae40238f8a3556e11074b)
  Verify CID hash of inline blocks received via
  GossipSub before storing in blockstore. Prevents
  acceptance of tampered or corrupted blocks from the
  gossip network. Shared verifyCid() utility extracted
  for reuse across fetch-tip and gossip bridge.
- [#116](https://github.com/gnidan/pokapali/issues/116)
  [`923f5f4`](https://github.com/gnidan/pokapali/commit/923f5f47a66d3a404ff49647d8c651df18da2312)
  Add JSDoc to all public exports across 13 source
  files: PokapaliConfig, PokapaliApp, pokapali(),
  Doc-related types (DocStatus, DocRole, LoadingState,
  GossipActivity, VersionHistoryEntry), diagnostics
  types (NodeInfo, Diagnostics, TopologyGraph), error
  classes, forwarding, auto-save, node-registry,
  topology-sharing, RotateResult, and version history.
- [#38](https://github.com/gnidan/pokapali/issues/38)
  [`bb15692`](https://github.com/gnidan/pokapali/commit/bb156928f657a1ffdaeea8ef8d375ed9d1620567)
  Fix markReady race when IPNS resolves before fetch starts

  `deriveLoadingState` now returns `"resolving"` (instead of
  `"idle"`) when IPNS has resolved a CID but the corresponding
  chain entry still has `blockStatus: "unknown"`. This prevents
  `markReady` from firing before the first snapshot is applied.

- [#120](https://github.com/gnidan/pokapali/issues/120)
  [`9ddd7e3`](https://github.com/gnidan/pokapali/commit/9ddd7e3c6501f9c7a13d0059baf52071d3e7b8f9)
  Rename TopologyGraphEdge → TopologyEdge

  Renames `TopologyGraphEdge` to `TopologyEdge` for consistency
  with the `TopologyGraph` and `TopologyNode` naming convention.
  The internal raw edge type (from node capability broadcasts)
  is renamed from `TopologyEdge` to `CapabilityEdge`.

- Updated dependencies
  - @pokapali/capability@0.1.2
  - @pokapali/snapshot@0.1.2
  - @pokapali/subdocs@0.1.2

## 0.1.2

### Patch Changes

- [#286](https://github.com/gnidan/pokapali/issues/286)
  [`c4231b4`](https://github.com/gnidan/pokapali/commit/c4231b42aa5ee2904cdbbec32cff1cf33f0d189d)
  Verify CID hash of blocks fetched from pinner
  HTTP tip endpoints. Rejects blocks whose content does
  not match the claimed CID, preventing acceptance of
  tampered or corrupted data.
- [#325](https://github.com/gnidan/pokapali/issues/325)
  [`7597cf0`](https://github.com/gnidan/pokapali/commit/7597cf00d2b4ff0a21c516b7775d2a42e8410eac)
  Add @deprecated JSDoc markers to implementation
  getters and methods for all deprecated APIs (provider,
  tipCid, ackedBy, guaranteeUntil, retainUntil,
  loadingState, on, off). IDEs now show strikethrough
  and deprecation warnings on usage.
- [#318](https://github.com/gnidan/pokapali/issues/318)
  [`8d9b97c`](https://github.com/gnidan/pokapali/commit/8d9b97c1ca52b9e3a918387c079639e0e370ba73)
  Document persistence:false for non-browser
  environments in guide.md and getting-started.md.
  [#319](https://github.com/gnidan/pokapali/issues/319) Document ready()
  timeout behavior: timeoutMs
  option and TimeoutError rejection in guide.md and
  getting-started.md.
  [#321](https://github.com/gnidan/pokapali/issues/321) Note
  createAutoSaver browser-only limitation in
  guide.md and integration-guide.md.
  [#322](https://github.com/gnidan/pokapali/issues/322) Document
  doc.urls.best tier selection logic
  (admin > write > read fallback) in guide.md.

## 0.1.2

### Patch Changes

- [#286](https://github.com/gnidan/pokapali/issues/286)
  [`c4231b4`](https://github.com/gnidan/pokapali/commit/c4231b42aa5ee2904cdbbec32cff1cf33f0d189d)
  Verify CID hash of blocks fetched from pinner
  HTTP tip endpoints. Rejects blocks whose content does
  not match the claimed CID, preventing acceptance of
  tampered or corrupted data.
- [#325](https://github.com/gnidan/pokapali/issues/325)
  [`7597cf0`](https://github.com/gnidan/pokapali/commit/7597cf00d2b4ff0a21c516b7775d2a42e8410eac)
  Add @deprecated JSDoc markers to implementation
  getters and methods for all deprecated APIs (provider,
  tipCid, ackedBy, guaranteeUntil, retainUntil,
  loadingState, on, off). IDEs now show strikethrough
  and deprecation warnings on usage.
- [#318](https://github.com/gnidan/pokapali/issues/318)
  [`8d9b97c`](https://github.com/gnidan/pokapali/commit/8d9b97c1ca52b9e3a918387c079639e0e370ba73)
  Document persistence:false for non-browser
  environments in guide.md and getting-started.md.
  [#319](https://github.com/gnidan/pokapali/issues/319) Document ready()
  timeout behavior: timeoutMs
  option and TimeoutError rejection in guide.md and
  getting-started.md.
  [#321](https://github.com/gnidan/pokapali/issues/321) Note
  createAutoSaver browser-only limitation in
  guide.md and integration-guide.md.
  [#322](https://github.com/gnidan/pokapali/issues/322) Document
  doc.urls.best tier selection logic
  (admin > write > read fallback) in guide.md.
