# HTTP Block Endpoint — Design

## Problem

GossipSub announcements inline block data up to 256KB
(`MAX_INLINE_BLOCK_BYTES` in announce.ts). Documents
larger than 256KB cannot be delivered via announcement.
Bitswap (the standard IPFS block exchange) does not work
between browsers and relays (known bug in tech-debt.md).

This means large documents silently fail to propagate:
the announcement arrives, but `fetchBlock` retries
against the blockstore (via Bitswap) and eventually
gives up after 6 retries (~2 minutes).

## Solution: HTTP Block Fetch on Relays

Add a `GET /block/:cid` endpoint to the relay HTTP
server. Browsers that fail to fetch a block via the
blockstore fall back to fetching it over HTTP from a
known relay.

### Why HTTP, not fixing Bitswap

Bitswap browser↔relay has an unknown root cause
(possibly session-based Bitswap not sending WANTs to
all connected peers). Fixing it requires deep libp2p
debugging with uncertain timeline. HTTP is a reliable,
well-understood transport that works today. The endpoint
also serves as a foundation for future features (CLI
reads, MCP server block access).

---

## Relay-side: `GET /block/:cid`

### Endpoint

```
GET /block/:cid
```

**Response:**

- `200 OK` with `application/octet-stream` body
  (raw block bytes)
- `404 Not Found` if the CID is not in the blockstore
- `400 Bad Request` if the CID is malformed
- `429 Too Many Requests` if rate-limited

**Headers:**

- `Content-Type: application/octet-stream`
- `Content-Length: <byte-count>`
- `Cache-Control: public, max-age=31536000, immutable`
  (blocks are content-addressed — a CID always maps
  to the same bytes)

### Implementation (http.ts)

Add to `startHttpServer` after the existing routes:

```ts
const blockMatch = url.pathname.match(/^\/block\/([a-zA-Z0-9]+)$/);
if (req.method === "GET" && blockMatch) {
  const cidStr = blockMatch[1];
  let cid: CID;
  try {
    cid = CID.parse(cidStr);
  } catch {
    res.writeHead(400, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        error: "invalid CID",
      }),
    );
    return;
  }

  // Rate limit: per-IP, 60 requests/minute
  if (blockRateLimiter.isLimited(req)) {
    res.writeHead(429, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        error: "rate limited",
      }),
    );
    return;
  }

  try {
    const block = await relay.helia.blockstore.get(cid);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(block.length),
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(block);
  } catch {
    res.writeHead(404, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        error: "block not found",
      }),
    );
  }
}
```

### Rate limiting

Reuse `createRateLimiter` from rate-limiter.ts with
per-IP keying:

- 60 requests/minute per IP
- IP extracted from `req.socket.remoteAddress`
- Existing rate-limiter uses a sliding window
  pattern — extend it or create a simple
  token-bucket for HTTP

This prevents abuse while allowing legitimate
fetches. Blocks are encrypted so content isn't
exposed, but unlimited fetches could be used for
bandwidth abuse.

### No authentication needed

Blocks are encrypted with `readKey`. Possessing a
CID without the readKey yields only ciphertext.
The CID itself is learned from:

1. A GossipSub announcement (requires subscribing
   to the announce topic with the appId)
2. An IPNS resolve (requires knowing the IPNS name
   from a capability URL)

Both require prior knowledge that is equivalent to
having the document URL. No additional auth layer is
needed — the capability URL model handles access
control.

---

## Browser-side: HTTP fallback in fetch-block.ts

### Discovery: how browsers find relay HTTP URLs

Browsers already know relay addresses from:

1. **peer-discovery.ts** — DHT-discovered relay
   multiaddrs, stored in `relayPeerIds`
2. **Node caps v2** — `addrs[]` field contains WSS
   multiaddrs like
   `/dns4/chi.pokapali.com/tcp/443/wss/...`

The HTTP URL is derived from the WSS multiaddr:

- `/dns4/chi.pokapali.com/tcp/443/wss/...`
  → `https://chi.pokapali.com`
- `/ip4/1.2.3.4/tcp/8443/wss/...`
  → `https://1.2.3.4:8443`

**Implementation:** Add `relayHttpUrl(multiaddr)`
utility to peer-discovery.ts that extracts the
host and port from a WSS multiaddr. Only WSS
addresses produce HTTPS URLs (plain WS → HTTP
is insecure from HTTPS pages, skip those).

**But:** The relay HTTP server runs on a separate
port (default 3000) from the WSS transport. The
WSS port is the libp2p transport port; the HTTP
status/block server is a separate `createServer`.

**Options:**

1. **Same port:** Serve HTTP block requests on the
   same port as WSS by adding an HTTP upgrade
   handler or running an HTTP server alongside the
   WebSocket transport. Complex — libp2p owns the
   transport.
2. **Known port offset:** HTTP port = WSS port + 1
   or a fixed well-known port (e.g., 443 for WSS,
   80 for HTTP). Fragile — port conventions vary.
3. **Advertise HTTP port in caps:** Add `httpPort`
   or `httpUrl` to the NodeCapsMessage v2/v3. The
   relay already advertises its WSS `addrs[]` — add
   an `httpUrl` string (e.g.,
   `"https://chi.pokapali.com:3000"`). Browsers
   read it from the node registry.

**Recommendation: option 3 (advertise in caps).**
It's explicit, works for any port/hostname
configuration, and requires minimal change:

- Relay: add `httpUrl` to caps message (derived
  from `--port` flag and the WSS hostname)
- node-registry.ts: add `httpUrl?: string` to
  `KnownNode`
- peer-discovery.ts: no change needed — browsers
  get the URL from the node registry

### Fallback integration in fetch-block.ts

Modify `fetchBlock` to accept an optional HTTP
fallback URL list:

```ts
export interface FetchBlockOptions {
  retries?: number;
  baseMs?: number;
  timeoutMs?: number;
  /** HTTP URLs of relays to try if blockstore
   *  fetch fails. Tried in order. */
  httpFallbackUrls?: string[];
}
```

After all blockstore retries are exhausted,
try each HTTP URL:

```ts
// After blockstore retries exhausted:
if (options?.httpFallbackUrls?.length) {
  for (const baseUrl of options.httpFallbackUrls) {
    try {
      const url = `${baseUrl}/block/${cid.toString()}`;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        const block = new Uint8Array(await resp.arrayBuffer());
        // Verify CID matches content
        // (content-addressed integrity)
        return block;
      }
    } catch {
      continue; // try next relay
    }
  }
}
throw lastError;
```

### Wiring in index.ts

In `createDoc`, when constructing the snapshot
watcher's `onSnapshot` callback, pass relay HTTP
URLs from the node registry:

```ts
onSnapshot: async (cid) => {
  const registry = getNodeRegistry();
  const httpUrls = registry.knownNodes()
    .filter((n) => n.connected && n.httpUrl)
    .map((n) => n.httpUrl!);

  const block = await fetchBlock(helia, cid, {
    httpFallbackUrls: httpUrls,
  });
  // ... rest of applyRemote
},
```

Wait — this doesn't quite work because
`applyRemote` calls `fetchBlock` internally. The
fix is to pass the fallback URLs through:

**Option A:** Add `httpFallbackUrls` to
`SnapshotLifecycleOptions` and thread it through
to the `fetchBlock` call in `applyRemote`.

**Option B:** Make `fetchBlock` a parameter of
`createSnapshotLifecycle` so the caller can wrap
it with fallback logic.

**Recommendation: Option A** — simpler, keeps the
fallback logic in `fetchBlock` where it belongs.

---

## Implementation Plan

### Step 1: Relay HTTP endpoint (ops)

**Files:** `packages/node/src/http.ts`

1. Import `CID` from multiformats
2. Add `GET /block/:cid` route after `/metrics`
3. Parse CID, validate, fetch from blockstore
4. Rate limit (per-IP, 60 req/min)
5. Return raw bytes with immutable cache headers

**Tests:** Add to a new `http.test.ts`:

- Valid CID → 200 + bytes
- Invalid CID string → 400
- Missing CID → 404
- Rate limit exceeded → 429

### Step 2: Caps httpUrl advertisement (ops)

**Files:**

- `packages/node/src/relay.ts` — add `httpUrl` to
  caps publish
- `packages/core/src/node-registry.ts` — add
  `httpUrl?: string` to `KnownNode` and
  `NodeCapsMessage`

1. Relay derives `httpUrl` from its configured
   port and the first WSS multiaddr hostname
2. Include in caps v2 message: `httpUrl: string`
3. node-registry parses and stores it

### Step 3: Browser fallback fetch (core)

**Files:**

- `packages/core/src/fetch-block.ts` — add
  `httpFallbackUrls` option + HTTP fetch loop
- `packages/core/src/snapshot-lifecycle.ts` — add
  `httpFallbackUrls` to options, pass to fetchBlock
- `packages/core/src/index.ts` — wire registry
  httpUrls into snapshot lifecycle options

1. Extend `FetchBlockOptions` with
   `httpFallbackUrls?: string[]`
2. After blockstore retries fail, try HTTP fetch
   from each URL
3. Thread URLs from node registry through
   snapshot lifecycle to fetchBlock

### Step 4: Tests (testing)

- `fetch-block.test.ts` — HTTP fallback (mock
  fetch, verify it's tried after blockstore fails)
- `http.test.ts` — endpoint tests
- Integration: announce >256KB block, verify
  browser fetches via HTTP fallback

---

## Size Considerations

- Max block size is bounded by snapshot encoding.
  A 1MB Y.Doc produces a ~1MB block. A 10MB doc
  produces a ~10MB block. The relay already has
  `MAX_BODY_BYTES = 6_000_000` for ingest — the
  GET endpoint should have a similar upper bound
  or simply serve whatever the blockstore has.
- For very large docs (>5MB), streaming the
  response is important. Node.js `res.end(block)`
  buffers the entire block — acceptable up to
  ~10MB, but for larger blocks consider
  `res.write()` with chunking.
- The `MAX_INLINE_BLOCK_BYTES` (256KB) threshold
  in announce.ts should not change — GossipSub
  messages have practical size limits.

## Security Notes

- Blocks are encrypted — serving raw bytes exposes
  only ciphertext to anyone without `readKey`
- CIDs are content-addressed — the response is
  self-verifying (hash the bytes, compare to CID)
- Rate limiting prevents bandwidth abuse
- No enumeration risk — you must know the CID to
  fetch (no listing endpoint)

## Future: CLI and MCP use

The HTTP block endpoint also enables:

- `pokapali-doc read <url>` can fetch blocks via
  HTTP instead of needing a full Helia stack
- MCP server can fetch blocks via HTTP for lower
  cold-start latency
- See cli-client.md for the CLI design
