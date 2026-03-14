# Infrastructure

## Permission-less Pinning Servers

Pinners are structurally zero-knowledge. They never
possess `readKey` and cannot decrypt document content or
`_meta`. A pinner is configured with one or more `appId`
values and automatically discovers and pins all
documents created by any user of those apps — no
per-document setup required.

### Discovery

When a peer pushes a snapshot, the library publishes the
block to the Helia blockstore, publishes an IPNS record
via delegated HTTP routing, then announces on the
GossipSub topic with inline block data. Pinners
subscribed to that topic discover documents
automatically.

On receiving an announcement, pinners validate inline
block data directly from the message — no blockstore
round-trip needed. They store validated blocks to the
persistent `FsBlockstore`. As a secondary fallback,
pinners periodically re-resolve all known IPNS names
(every 5 minutes).

### Jobs

Once a pinner discovers an IPNS name:

1. Validate inline block data from announcements (or
   resolve IPNS as fallback) → verify snapshot
   signature → pin to `FsBlockstore`
2. **Keep all snapshots from the last 24 hours** —
   time-windowed, not count-based
3. Prune snapshots older than 24 hours (always keep
   the tip regardless of age)
4. **Re-publish DHT IPNS records every ~4 hours** —
   uses `republishRecord` (no private key needed),
   sequential with 5s per-name delays
5. **Re-announce known CIDs** with inline blocks so
   late-joining peers can fetch blocks without Bitswap

### Pinner acknowledgment

When a pinner successfully ingests a snapshot, it
publishes an ack on the announce topic:

```ts
interface AnnouncementAck {
  ipnsName: string;
  cid: string;
  ack: true;
  peerId: string;
  guaranteeUntil?: number; // ms epoch
  retainUntil?: number; // ms epoch
}
```

Writers track `ackedBy` (deduped by peerId) to display
"Saved to N relay(s)" in the UI. Pinners track
`lastAckedCid` per IPNS name to avoid redundant
re-fetches.

### Two-phase guarantee protocol

Pinners provide a two-phase commitment for each
document:

1. **Active re-announcing (7 days).** The pinner
   continues re-announcing on GossipSub with inline
   blocks. Re-announce frequency follows the decay
   formula, capped at once per 24 hours.
   `guaranteeUntil = lastSeenAt + 7 days`.

2. **Block retention (14 days total).** After
   re-announcing stops, blocks stay in `FsBlockstore`
   and IPNS records continue being republished.
   `retainUntil = lastSeenAt + 14 days`.

Both timestamps are absolute (ms since epoch),
idempotent on re-announce. Any activity refreshes
`lastSeenAt` and extends both windows.

### Continuous scheduling (designed)

At scale, the flat re-announce loop becomes the
bottleneck. The replacement is a continuous priority
model:

- Re-announce interval scales with inactivity:
  `interval = BASE * 2^(age/HALF_LIFE) * loadFactor`
- A **min-heap priority queue** ordered by
  next-deadline replaces the flat loop
- Constants: `BASE` (30s), `HALF_LIFE` (12h),
  `MAX_INTERVAL` (24h), `GUARANTEE_DURATION` (7d),
  `RETENTION_DURATION` (14d)

Interval progression at idle:

```
t=0:      30s       t=3d:     32min
t=12h:    60s       t=4d:     ~2h
t=1d:     2min      t=5d:     ~8.5h
t=2d:     8min      t=5.5d+:  24h (capped)
```

**Fan-in: demand-driven priority boost.** When a pinner
receives a `guarantee-query` for a document, it resets
the decay interval to `BASE`. This gives readers fast
block availability even for documents idle for days.

**Reader activity as demand signal.** Non-pinner
re-announces update `lastSeenAt` and extend guarantee
windows. Pinner re-announces (`fromPinner: true`) are
excluded to prevent pinners from keeping each other
alive indefinitely.

**State pruning.** Primary: prune when
`lastSeenAt + 14d < now`. Capacity backstop: if
tracking exceeds `maxActiveDocs * 10`, prune
oldest-by-`lastSeenAt` first.

### Multi-pinner redundancy

Adding more pinners improves:

1. **Redundancy** — each independently stores blocks.
   If one crashes, others still serve the doc.
2. **Load distribution** — with sharding
   (`--shard N/M`), each handles fewer docs.
3. **Independent clocks** — each pinner's guarantee is
   based on its own `lastSeenAt`.

### Guarantee query protocol

When a browser opens a document, it may not receive
pinner acks for minutes if the pinner's re-announce
interval has decayed.

**Protocol flow:**

1. Browser subscribes to announce topic and waits
   **3 seconds** for mesh formation (GRAFT requires
   at least one heartbeat)
2. Browser publishes `guarantee-query` containing
   `{ appId, ipnsName }`
3. Each pinner responds with
   `{ peerId, cid, guaranteeUntil, retainUntil }`
4. Browser updates guarantees (monotonic `Math.max`
   per pinner)

**Timing:** Initial query at 3s after subscribe;
periodic re-query every 5 minutes; event-driven on
pinner discovery via node caps.

### Rate limiting

Per-IPNS-name rate limiting protects pinner resources:

```ts
const RATE_LIMIT = {
  maxSnapshotsPerHour: 60,
  maxBlockSizeBytes: 5_000_000,
};
```

---

## Server-side: `@pokapali/node`

The `@pokapali/node` package provides `startRelay()`,
`createPinner()`, and an HTTP server. A relay is generic
network infrastructure (any relay serves any app); a
pinner is configured with specific `appId` values. Both
typically run in the same Node.js process, sharing a
single Helia instance.

### Pinner state persistence

State (`knownNames`, `tips`, `nameToAppId`,
`lastSeenAt`) is persisted to `state.json`. Writes use
a dirty-flag + 5-second debounced flush + 60-second
safety-net interval. On startup, state is restored so
the pinner can immediately re-announce inline blocks.

Shutdown is graceful: `stop()` sets a `stopped` flag,
cancels timers, flushes in-flight operations via
`Promise.allSettled`, and persists state to disk.

### Relay configuration

The relay runs Helia with full libp2p defaults,
client-mode DHT, GossipSub (tuned D/Dlo/Dhi for small
networks), autoTLS for WSS, and persistent key +
datastore.

**Relay-to-relay GossipSub topology.** Relays use mesh
routing (`floodPublish: false`) with D=3, Dlo=2, Dhi=8.
Relays discover each other via DHT
`findProviders(networkCID)` and tag connections (value 200) to prevent pruning. GossipSub naturally GRAFTs
connected relays into the mesh.

No relay addresses are hardcoded. Discovery is entirely
via DHT.

### HTTP endpoints

| Endpoint       | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `GET /health`  | Returns 200 when running (~25s startup for autoTLS) |
| `GET /status`  | JSON diagnostics: peers, mesh stats, pinner state   |
| `GET /metrics` | Prometheus-formatted metrics                        |

### HTTP block endpoint

Separate HTTPS server on port 4443 (configurable via
`--https-port`). Reuses autoTLS certificate from
`@ipshipyard/libp2p-auto-tls`.

**Endpoints:**

- `GET /block/:cid` — returns raw bytes. Client
  verifies by hashing against requested CID.
  Returns 404 if not in blockstore.
- `POST /block/:cid` — writers upload blocks. Server
  verifies hash matches CID. No auth needed — CIDs
  are self-authenticating.

**Security:** CORS `*` by default (configurable),
per-IP rate limiting (60/min), 6MB body cap.

**Discovery:** Relay advertises `httpUrl` in its v2
node caps message.

| Flag                  | Default | Purpose                   |
| --------------------- | ------- | ------------------------- |
| `--https-port`        | 4443    | Block endpoint HTTPS port |
| `--cors-origin`       | `*`     | CORS allowed origin       |
| `--rate-limit-rpm`    | 60      | Per-IP requests/minute    |
| `--trust-proxy`       | false   | Trust X-Forwarded-For     |
| `--delegated-routing` | (none)  | Delegated routing URL     |

### Pinner history endpoint

`GET /history/:ipnsName` — returns the pinner's known
snapshot list for the IPNS name, newest-first.

| Param    | Default | Description                           |
| -------- | ------- | ------------------------------------- |
| `limit`  | 50      | Max entries (capped at 200)           |
| `before` | —       | Pagination: entries with seq < before |

```json
[
  { "cid": "bafyrei...", "ts": 1710123456789, "seq": 42 },
  { "cid": "bafyrei...", "ts": 1710123400000, "seq": 41 }
]
```

Client-side: `doc.versionHistory()` queries pinner
history endpoints automatically, falling back to local
chain walk.

---

## Node Capability Broadcasting

Nodes advertise roles via GossipSub topic
`pokapali._node-caps._p2p._pubsub`. Every 30 seconds:

```ts
interface NodeCapsMessage {
  version: 1 | 2;
  peerId: string;
  roles: string[]; // e.g. ["relay", "pinner"]
  // v2 additions:
  neighbors?: Neighbor[];
  browserCount?: number;
  addrs?: string[]; // WSS multiaddrs
  httpUrl?: string; // HTTPS block endpoint URL
}
```

Version 2 caps enable topology map construction: relays
report neighbors and browser count.

On the browser side, `@pokapali/core` maintains a
**node registry** (per-Helia singleton) that subscribes
to caps, upserts known nodes, prunes stale entries (no
message in 90 seconds), and cross-references with
`libp2p.getConnections()` for live status.

```ts
interface NodeInfo {
  peerId: string;
  short: string;
  connected: boolean;
  roles: string[];
  rolesConfirmed: boolean;
  ackedCurrentCid: boolean;
  lastSeenAt: number;
  neighbors: Neighbor[];
  browserCount: number | undefined;
}
```

---

## Document Lifetime Metrics (designed)

Pinners track cumulative document lifetime data to
validate that guarantees match reality.

**Per-doc state:** `firstSeenAt` (not yet implemented).

**Counters** (reset on restart):

| Counter             | Updated when                           |
| ------------------- | -------------------------------------- |
| `docsTracked`       | new IPNS name discovered               |
| `docsPruned`        | doc removed from state                 |
| `guaranteesIssued`  | ack sent with `guaranteeUntil`         |
| `guaranteesHonored` | doc pruned after its `guaranteeUntil`  |
| `guaranteesBroken`  | doc pruned before its `guaranteeUntil` |

**Gauges:**

| Gauge          | Meaning                      |
| -------------- | ---------------------------- |
| `activeDocs`   | docs in re-announce phase    |
| `retainedDocs` | past guarantee, before prune |
| `utilization`  | activeDocs / capacity        |

Exposed on `/status` as JSON.
