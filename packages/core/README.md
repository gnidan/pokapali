# @pokapali/core

> **This package is not published to npm.** It is under
> active development and not yet ready for production use.

Main integration layer for Pokapali. Provides the
`createCollabLib` factory for creating and opening
collaborative documents, managing WebRTC sync, pushing
and receiving IPFS snapshots, and generating capability
URLs. This is the only package most apps need to import.

## Key Exports

- **`createCollabLib(options)`** — factory that returns
  `create()` and `open()` methods for document lifecycle
- **`CollabDoc`** — document handle with subdoc access,
  awareness, capability info, snapshot push, status, and
  `whenReady()` (resolves after initial IPNS resolve and
  first snapshot application for readers)
- **`CollabLibOptions`** — configuration: `appId`,
  `namespaces`, `base` URL, optional bootstrap peers
- **`DocStatus`** — `"connecting"` | `"syncing"` |
  `"synced"` | `"offline"` | `"unpushed-changes"`

## Internal Modules

- `snapshot-lifecycle` — chain state, push, applyRemote,
  history, loadVersion
- `snapshot-watcher` — GossipSub announce subscription,
  IPNS polling, retry scheduling. Supports max retries
  with a `"failed"` fetch state, pinner ack tracking
  (`ackedBy`, `"ack"` event), and a `"resolving"` fetch
  state for IPNS resolve-in-progress feedback
- `fetch-block` — block fetch with exponential backoff
  retry and abort timeout
- `relay-sharing` — awareness-based relay address exchange
- `peer-discovery` — relay DHT discovery with disconnect
  reconnection and keep-alive tag recovery
- `relay-cache` — localStorage relay cache with migration,
  TTL filtering, and upsert/remove helpers (extracted from
  peer-discovery for independent testability)
- `ipns-helpers` — IPNS publish queue and resolve
- `announce` — GossipSub snapshot announcement protocol
- `helia` — shared Helia singleton with ref counting and
  30-second bootstrap timeout
- `forwarding` — document rotation forwarding records
- `auto-save` — `createAutoSaver()` debounced auto-push
  utility (snapshot-recommended, beforeunload,
  visibilitychange)
- `url-utils` — `isDocUrl()`, `bestUrl`, `role` helpers

## Links

- [Root README](../../README.md)
- [Getting Started](../../docs/guide.md)
- [Architecture](../../docs/architecture.md)
