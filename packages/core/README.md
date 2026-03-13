# @pokapali/core

```sh
npm install @pokapali/core
```

Main integration layer for Pokapali. Provides the
`pokapali` factory for creating and opening collaborative
documents, managing WebRTC sync, pushing and receiving
IPFS snapshots, and generating capability URLs. This is
the only package most apps need to import.

## Key Exports

- **`pokapali(config)`** — factory that returns a
  `PokapaliApp` with `create()` and `open()` methods
  for document lifecycle
- **`Doc`** — document handle with channel access,
  awareness, capability info, publish, status, and
  `ready()` (resolves after initial IPNS resolve and
  first snapshot application for readers)
- **`PokapaliConfig`** — configuration: `appId`,
  `channels`, `origin` URL, optional `primaryChannel`,
  `rtc`, `signalingUrls`, `bootstrapPeers`
- **`DocStatus`** — `"connecting"` | `"synced"` |
  `"receiving"` | `"offline"` (connectivity only)
- **`SaveState`** — `"saved"` | `"dirty"` | `"saving"` |
  `"unpublished"` (persistence, via `doc.saveState`)
- **`LoadingState`** — `"idle"` | `"resolving"` |
  `"fetching"` | `"retrying"` | `"failed"` (snapshot
  fetch progress)
- **`TopologyGraph`** — `topologyGraph()` return type
  with nodes and edges for network visualization
- **`createAutoSaver(doc)`** — debounced auto-publish
  utility (publish-needed, beforeunload, visibilitychange)

## Internal Modules

- `snapshot-lifecycle` — chain state, push, applyRemote,
  history, loadVersion
- `fetch-block` — block fetch with exponential backoff
  retry and abort timeout
- `relay-sharing` — awareness-based relay address exchange
- `topology-sharing` — awareness-based relay topology
  sharing with knownNodes caps rebroadcast (5s debounce)
- `peer-discovery` — relay DHT discovery with disconnect
  reconnection and exponential backoff
- `relay-cache` — localStorage relay cache with migration,
  TTL filtering, and upsert/remove helpers (extracted from
  peer-discovery for independent testability)
- `node-registry` — per-Helia singleton tracking known
  nodes via capability broadcasts (v1/v2), DHT discovery,
  and ack data; exposes `NodeInfo[]` for diagnostics with
  neighbors and browserCount from v2 caps
- `ipns-helpers` — IPNS publish queue (delegated HTTP)
  and resolve (delegated-first, DHT fallback)
- `announce` — GossipSub snapshot announcement, ack, and
  guarantee query/response protocol
- `helia` — shared Helia singleton with ref counting and
  30-second bootstrap timeout
- `forwarding` — document rotation forwarding records
- `auto-save` — `createAutoSaver()` debounced auto-push
  utility (publish-needed, beforeunload, visibilitychange)
- `url-utils` — `isDocUrl()`, `bestUrl`, `role` helpers

## Links

- [Root README](../../README.md)
- [Getting Started](../../docs/guide.md)
- [Architecture](../../docs/architecture.md)
