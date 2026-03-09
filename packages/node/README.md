# @pokapali/node

> **This package is not published to npm.** It is under
> active development and not yet ready for production use.

Node.js server components for Pokapali: a generic relay
for GossipSub mesh connectivity, a zero-knowledge pinner
for snapshot ingestion and IPNS republishing, and an HTTP
server for health monitoring. Provides the `pokapali` CLI
for running relay + pinner nodes on a VPS.

## Key Exports

- **`startRelay(config)`** — starts a Helia node with
  libp2p, client-mode DHT, GossipSub, autoTLS, and
  persistent key/datastore
- **`createPinner(config)`** — subscribes to announce
  topics, fetches and validates snapshots, maintains a
  24-hour history window, republishes IPNS records
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
- [Architecture — Pinning Servers](../../docs/architecture.md)
