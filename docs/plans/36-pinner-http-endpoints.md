# #36 Pinner HTTP Endpoints for Browsers

**Date:** 2026-03-12
**Author:** architect
**Status:** DESIGN (pending approval)

## Problem

Browsers currently rely on GossipSub for two
critical operations that could be faster via HTTP:

1. **Initial load (30s+ delay):** Browser opens a
   doc → connects to relay → forms GossipSub mesh
   (~10-30s) → receives announcement or does IPNS
   resolve → fetches block. The mesh formation wait
   dominates time-to-first-paint.

2. **Guarantee queries (fan-in, #35):** Browser
   sends guarantee-query over GossipSub → waits for
   pinner responses → may miss responses if mesh
   isn't formed yet. Unreliable timing.

Both operations require data the pinner already has
(tip CID, block bytes, guarantee state) and can be
served over the existing HTTPS block server.

## Solution: Two New Endpoints

Add to the existing HTTPS block server (port 4443,
autoTLS, CORS, rate-limited):

### 1. GET /tip/:ipnsName (priority)

Returns the latest CID and block data for an IPNS
name. Enables "fast initial load" — browser fetches
directly from pinner, skipping mesh formation and
IPNS resolution entirely.

```
GET /tip/:ipnsName HTTP/1.1

200 OK
Content-Type: application/json
Cache-Control: no-cache
{
  "ipnsName": "abc123...",
  "cid": "bafy...",
  "block": "<base64-encoded block bytes>",
  "seq": 5,
  "ts": 1710000000000,
  "guaranteeUntil": 1710604800000,
  "retainUntil": 1711209600000
}

404 Not Found  (unknown IPNS name)
429 Too Many Requests
```

Design decisions:

- **Block inline as base64** — same encoding as
  GossipSub announcements. Avoids a second HTTP
  round-trip. Blocks are typically <1MB; base64
  overhead (~33%) is acceptable for the latency win.
  Max response size: ~8MB (6MB block cap × 1.33).

- **Guarantee included** — saves a separate
  /guarantee request. The pinner computes the
  guarantee anyway (issueGuarantee), so it's free.

- **no-cache** — tip changes on every publish. CID
  is immutable but which CID is the tip is not.

- **seq + ts included** — browser needs these for
  chain state (version history display).

- **No auth** — pinners can't decrypt blocks. Same
  trust model as GossipSub announcements. Blocks are
  encrypted snapshots; serving ciphertext over HTTPS
  exposes nothing beyond what GossipSub broadcasts.

- **IPNS name validation** — must be hex string
  (64 chars). Reject non-hex early (400).

### 2. GET /guarantee/:ipnsName (secondary)

Returns guarantee status without the block. For
browsers that already have the block but need
guarantee state (e.g., after reconnect).

```
GET /guarantee/:ipnsName HTTP/1.1

200 OK
Content-Type: application/json
{
  "ipnsName": "abc123...",
  "cid": "bafy...",
  "peerId": "12D3Koo...",
  "guaranteeUntil": 1710604800000,
  "retainUntil": 1711209600000
}

404 Not Found  (unknown IPNS name)
429 Too Many Requests
```

Design decisions:

- **Same shape as GuaranteeResponse** from
  announce.ts — browser reuses the same parsing code
  for GossipSub and HTTP responses.

- **peerId included** — identifies which pinner is
  responding (same as GossipSub guarantee-response).

- **No rate-limit cooldown per name** — unlike the
  GossipSub handler (3s cooldown per name), HTTP
  requests are stateless. Per-IP rate limiting is
  sufficient.

## Browser-Side Integration

### Fast-path on doc open

When a browser opens a doc, if httpUrls are known
(from caps or cache), try HTTP tip fetch FIRST:

```
doc.open() flow:

1. If httpUrls available:
   a. GET /tip/:ipnsName from each URL (race)
   b. On success: emit cid-discovered + block-fetched
      facts → immediate apply (no mesh wait)
   c. On failure: fall through to existing path

2. Existing path (unchanged):
   a. Connect to relay, form GossipSub mesh
   b. Publish guarantee-query
   c. IPNS resolve
   d. Fetch block
```

The HTTP fast-path is **additive** — it runs in
parallel with mesh formation, not instead of it.
If HTTP succeeds first, the doc loads immediately.
GossipSub still forms in the background for live
updates.

### Implementation in create-doc.ts

New effect or early-init path in create-doc.ts:

```typescript
// Early HTTP tip fetch — runs before interpreter
// starts, in parallel with Helia/mesh setup.
async function httpTipFetch(
  httpUrls: string[],
  ipnsName: string,
): Promise<{
  cid: CID;
  block: Uint8Array;
  seq: number;
  ts: number;
  guaranteeUntil?: number;
  retainUntil?: number;
} | null> {
  for (const baseUrl of httpUrls) {
    try {
      const resp = await fetch(`${baseUrl}/tip/${ipnsName}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      if (!json.cid || !json.block) continue;

      const cid = CID.parse(json.cid);
      const block = base64ToUint8(json.block);

      // Verify block integrity
      const hash = await sha256.digest(block);
      const verified = CID.createV1(cid.code, hash);
      if (!verified.equals(cid)) continue;

      return {
        cid,
        block,
        seq: json.seq,
        ts: json.ts,
        guaranteeUntil: json.guaranteeUntil,
        retainUntil: json.retainUntil,
      };
    } catch {
      continue;
    }
  }
  return null;
}
```

The result feeds into the fact queue as:

- `cid-discovered` (source: "http-tip")
- `block-fetched`
- Guarantee facts if present

### HTTP guarantee query (replaces GossipSub)

After doc open, the browser can query guarantees
via HTTP instead of (or in addition to) GossipSub:

```typescript
// In snapshot-watcher.ts or interpreter effects
async function httpGuaranteeQuery(
  httpUrls: string[],
  ipnsName: string,
): Promise<GuaranteeResponse | null> {
  for (const baseUrl of httpUrls) {
    try {
      const resp = await fetch(`${baseUrl}/guarantee/${ipnsName}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      if (!json.peerId || !json.cid) continue;
      return json as GuaranteeResponse;
    } catch {
      continue;
    }
  }
  return null;
}
```

### Discovery: httpUrls from caps

Already implemented. `node-registry.ts` parses
`httpUrl` from v2 caps messages. `getHttpUrls()`
in create-doc.ts collects URLs from known nodes.

For the fast-path to work on first load (before
caps arrive), browsers need cached httpUrls from a
previous session. This pairs naturally with #20
(IndexedDB persistence) — cache known relay URLs
alongside doc state.

**Fallback for first-ever load:** No cached URLs →
no HTTP fast-path → existing GossipSub path. After
the first session, URLs are cached. Acceptable
cold-start penalty.

## Server-Side Implementation

### Pinner interface additions

```typescript
export interface Pinner {
  // ... existing methods ...

  /** Get tip CID + block for HTTP serving. */
  getTipData(ipnsName: string): Promise<{
    cid: string;
    block: Uint8Array;
    seq: number;
    ts: number;
    guaranteeUntil: number;
    retainUntil: number;
  } | null>;

  /** Get guarantee status for HTTP serving. */
  getGuarantee(ipnsName: string): {
    cid: string;
    peerId: string;
    guaranteeUntil: number;
    retainUntil: number;
  } | null;
}
```

`getTipData` reads from existing in-memory state:

- `history.getTip(ipnsName)` → CID string
- `helia.blockstore.get(cid)` → block bytes
- `history.getHistory(ipnsName)` → seq/ts
- `issueGuarantee(ipnsName)` → guarantee

`getGuarantee` is synchronous — all data is in
memory (`guaranteedUntil` Map, `history.getTip`).

### HttpsConfig additions

```typescript
export interface HttpsConfig {
  // ... existing fields ...

  /** Pinner tip data for /tip endpoint. */
  getTipData?: (ipnsName: string) => Promise<{
    cid: string;
    block: Uint8Array;
    seq: number;
    ts: number;
    guaranteeUntil: number;
    retainUntil: number;
  } | null>;

  /** Pinner guarantee data for /guarantee. */
  getGuarantee?: (ipnsName: string) => {
    cid: string;
    peerId: string;
    guaranteeUntil: number;
    retainUntil: number;
  } | null;
}
```

### Endpoint handlers (in startBlockServer)

Added before the existing /block/:cid handler:

```typescript
// GET /tip/:ipnsName
const tipMatch = url.pathname.match(/^\/tip\/([a-fA-F0-9]+)$/);
if (req.method === "GET" && tipMatch && config.getTipData) {
  const ip = getClientIp(req, config.trustProxy);
  if (!limiter.check(ip)) {
    res.writeHead(429, cors);
    res.end();
    return;
  }
  limiter.record(ip);

  const ipnsName = tipMatch[1];
  const data = await config.getTipData(ipnsName);
  if (!data) {
    res.writeHead(404, {
      "content-type": "application/json",
      ...cors,
    });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const body = {
    ipnsName,
    cid: data.cid,
    block: uint8ToBase64(data.block),
    seq: data.seq,
    ts: data.ts,
    guaranteeUntil: data.guaranteeUntil,
    retainUntil: data.retainUntil,
  };

  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-cache",
    ...cors,
  });
  res.end(JSON.stringify(body));
  return;
}

// GET /guarantee/:ipnsName
const guarMatch = url.pathname.match(/^\/guarantee\/([a-fA-F0-9]+)$/);
if (req.method === "GET" && guarMatch && config.getGuarantee) {
  const ip = getClientIp(req, config.trustProxy);
  if (!limiter.check(ip)) {
    res.writeHead(429, cors);
    res.end();
    return;
  }
  limiter.record(ip);

  const ipnsName = guarMatch[1];
  const data = config.getGuarantee(ipnsName);
  if (!data) {
    res.writeHead(404, {
      "content-type": "application/json",
      ...cors,
    });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-cache",
    ...cors,
  });
  res.end(
    JSON.stringify({
      ipnsName,
      ...data,
    }),
  );
  return;
}
```

## Packages Affected

### packages/node (server side)

| File            | Changes                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pinner.ts` | Add `getTipData()`, `getGuarantee()` to Pinner interface and implementation. Read from existing in-memory state.                         |
| `src/http.ts`   | Add GET /tip/:ipnsName and GET /guarantee/:ipnsName handlers in `startBlockServer()`. Add `getTipData`, `getGuarantee` to `HttpsConfig`. |
| `bin/node.ts`   | Wire pinner.getTipData and pinner.getGuarantee into HttpsConfig.                                                                         |

### packages/core (browser side)

| File                | Changes                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `src/create-doc.ts` | Add `httpTipFetch()` function. Call early in doc open flow, emit facts on success. |
| `src/announce.ts`   | Export `base64ToUint8` (already exists, may need re-export).                       |
| `src/facts.ts`      | Add `"http-tip"` to CidSource union type.                                          |

### Test files

| File                        | Scope                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| `src/http.test.ts` (node)   | GET /tip (happy, 404, 429, invalid name), GET /guarantee (happy, 404, 429) |
| `src/pinner.test.ts` (node) | getTipData returns correct data, getGuarantee returns guarantee state      |

## Backward Compatibility

| Scenario               | Behavior                               |
| ---------------------- | -------------------------------------- |
| Old relay, new browser | No /tip endpoint → 404 → existing path |
| New relay, old browser | Endpoints exist but unused             |
| New relay, new browser | HTTP fast-path → immediate load        |

No breaking changes. No deploy ordering.

## Security

- **No auth** — same as GET /block/:cid. Pinners
  serve encrypted ciphertext. Reader-enforced only.
- **Rate limiting** — per-IP, shared with block
  endpoint. Prevents enumeration.
- **IPNS name validation** — hex-only regex prevents
  path traversal.
- **Block integrity** — browser verifies CID hash
  (same as existing HTTP block fetch).
- **No IPNS name enumeration** — 404 for unknown
  names. Names are 64-char hex (256-bit keyspace).
  Brute-force infeasible.

## Performance Impact

- **Pinner:** Negligible. getTipData does one
  blockstore.get (likely cached in OS page cache)
  plus in-memory lookups. getGuarantee is pure
  in-memory.
- **Network:** One HTTP request replaces: mesh
  formation + guarantee-query + IPNS resolve +
  block fetch. Net reduction in traffic.
- **Browser:** Time-to-first-paint drops from
  10-30s to <2s (single HTTP round-trip).

## Open Questions

1. **Should /tip also refresh lastSeenAt?** A tip
   fetch implies an active reader. Refreshing
   lastSeenAt would extend the guarantee window.
   **Recommendation: yes** — same semantics as a
   GossipSub announcement. Add
   `pinner.recordActivity(ipnsName)` call.

2. **Should we race multiple pinner URLs?** The
   design fetches sequentially (first success wins).
   Racing with `Promise.any()` would be faster but
   doubles server load. **Recommendation: race** —
   fast initial load is the whole point. Server load
   is bounded by rate limiting.

3. **Cache httpUrls in IndexedDB?** Needed for the
   fast-path to work on page reload (before caps
   arrive). **Recommendation: defer to #20** —
   IndexedDB persistence already caches doc state;
   adding URL cache is a natural extension.
