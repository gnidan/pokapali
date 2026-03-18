# @pokapali/node

```sh
npm install @pokapali/node
```

Node.js server components for Pokapali: a generic relay
for GossipSub mesh connectivity, a zero-knowledge pinner
for snapshot ingestion and IPNS republishing, and an HTTP
server for health monitoring. Provides the `pokapali` CLI
for running relay + pinner nodes on a VPS.

## Key Exports

- **`startRelay(config)`** — starts a Helia node with
  libp2p, client-mode DHT, GossipSub, autoTLS, persistent
  key/datastore, and `FsBlockstore` for persistent block
  storage. Broadcasts node capabilities on
  `pokapali._node-caps._p2p._pubsub` every 30 seconds
- **`createPinner(config)`** — subscribes to announce
  topics, fetches and validates snapshots, maintains a
  24-hour history window, republishes IPNS records.
  State (`knownNames`, `tips`, `nameToAppId`) is persisted
  to `state.json` with dirty-flag debounced writes
- **`startHttpServer(config)`** — HTTP server with
  `GET /healthz` and `GET /status` endpoints
- **`createRateLimiter(config)`** — per-IPNS-name rate
  limiting for pinner ingestion
- **`createHistoryTracker()`** — time-windowed snapshot
  history with pruning

## CLI

```sh
npx pokapali \
  --relay \
  --pin my-app-id \
  --port 3001 \
  --storage-path /var/lib/pokapali
```

## Links

- [Root README](../../README.md)
- [Architecture — Pinning Servers](../../docs/internals/)
