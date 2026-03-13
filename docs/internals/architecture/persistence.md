# Persistence & IPNS

## Linked-List Snapshot DAG

Each snapshot contains the full state of every channel,
encoded independently.

```ts
interface SnapshotNode {
  subdocs: {
    [channel: string]: Uint8Array;
    // Y.encodeStateAsUpdate — complete encrypted
    // state per channel (including "_meta")
  };
  prev: CID | null; // link to previous snapshot
  seq: number; // Y.Doc clockSum — deterministic
  //   IPNS ordering
  ts: number; // unix timestamp
  signature: Uint8Array; // Ed25519 sign of
  //   (subdocs | prev | seq | ts) with ipnsKey
  publicKey: Uint8Array; // ipnsKey public key
}
```

```
IPNS name
  └─> CID_n (latest)
        ──prev──> CID_n-1
           ──prev──> ...
              ──prev──> CID_1 (null)

Any single CID = complete document recovery
prev chain = version history only
```

---

## IPNS Publishing and Resolution

### Publishing

Writers publish IPNS records via **delegated HTTP
routing** (`delegatedRouting.putIPNS`). Browser-side
DHT publishing is not used — it hangs in browser
environments.

The IPNS sequence number is the **Y.Doc clockSum** —
the sum of all state vector clocks across all channels.
This is deterministic: the same document state always
produces the same seq, so multiple browsers publishing
the same snapshot produce identical IPNS records. On
publish, the library guards against stale seq after
page reload: `effectiveSeq = max(existingSeq + 1,
clockSum)`.

Publishes are serialized per key within a tab via a
publish queue. If a publish is in-flight and a newer
CID is queued, the stale CID is skipped.

### Resolution

All clients resolve IPNS on `open()` to load the
latest snapshot from the network. This is non-blocking
— the doc opens immediately for WebRTC sync, and the
resolved snapshot is applied via Yjs CRDT merge.

Resolution tries **delegated HTTP first** (fast,
reliable), falling back to **full Helia routing**
(includes DHT) if delegated fails. Both paths have a
15s timeout.

### Snapshot notification channels

| Channel                 | Speed     | Persistence | Use                                              |
| ----------------------- | --------- | ----------- | ------------------------------------------------ |
| GossipSub announcements | Immediate | Ephemeral   | Fast propagation to online pinners and all peers |
| IPNS polling (30s)      | Delayed   | N/A         | Fallback when no GossipSub peers connected       |
| DHT (IPNS resolve)      | ~seconds  | ~24h        | Cold bootstrap, pinner re-resolution             |

### GossipSub announcements

Writers publish on topic `/pokapali/app/{appId}/announce`
immediately after each `publish()`:

```ts
interface Announcement {
  ipnsName: string; // hex-encoded IPNS name
  cid: string; // CID of the snapshot block
  blockData?: string; // base64-encoded block (inline)
  fromPinner?: true; // set by pinner re-announces
}
```

### Three-tier block distribution

Bitswap does not work for browser→relay block fetching
(NAT/WebRTC prevents inbound connections). Blocks are
distributed via three tiers based on size:

| Size  | Transport            | Writer path                                              | Reader path                         |
| ----- | -------------------- | -------------------------------------------------------- | ----------------------------------- |
| <1MB  | GossipSub inline     | base64 `blockData` in announcement                       | announcement handler                |
| 1–6MB | HTTP POST + announce | POST to relay's `/block/:cid`, then announce (no inline) | HTTP GET from relay's `/block/:cid` |
| >6MB  | Rejected             | Error at publish time                                    | N/A                                 |

The GossipSub wire limit is 4MB per RPC frame
(`it-length-prefixed`); the 1MB inline guard
(`MAX_INLINE_BLOCK_BYTES`) keeps base64-encoded blocks
(~1.33MB) well within this limit.

### Re-announce and propagation

Writers re-announce every 15 seconds. All clients —
readers and writers — subscribe to announcements, apply
snapshots, and then re-announce the CID (with inline
block) and store the block in their local blockstore.
This makes every connected peer a gossip amplifier.

As a fallback, all clients poll IPNS via `watchIPNS`
(30s interval).

---

## Version History

Version history falls out of the persistence design
with no additional infrastructure.

### Current tip

```ts
doc.tipCid; // CID | null
// Also: doc.tipFeed (reactive)
```

### Listing versions

**Recommended — `versionHistory()`:**

```ts
const versions = await doc.versionHistory();
// Array<{ cid: CID; seq: number; ts: number }>
```

Returns versions **newest-first**. Automatically
queries connected pinners' HTTP history endpoints,
falling back to a local chain walk if no pinners are
reachable.

**Low-level — `history()`:**

```ts
const versions = await doc.history();
```

Walks the local snapshot chain from the current tip.
Uses a three-tier block resolution strategy:

1. **In-memory cache** — blocks from locally-pushed
   snapshots
2. **Helia blockstore** — blocks from GossipSub or
   prior fetches (5s timeout)
3. **HTTP fallback** — fetches from pinner/relay
   `httpUrl` endpoints, verifying the response hash
   against the requested CID's multihash

If a block is missing after all three tiers, the walk
stops gracefully — the returned list is partial rather
than throwing.

### Loading a version

```ts
const channels = await doc.loadVersion(cid);
// Record<string, Y.Doc>
```

Returns an independent `Y.Doc` for each channel. These
are copies — modifying them does not affect the live
document.

### Restoring a version

Restore creates a **new version** — it does not revert
or discard later versions. The snapshot chain is
append-only (CIDs are content hashes), so history is
immutable.

The restore strategy depends on your content type and
editor. Core provides `loadVersion()` as the primitive;
your app applies the old content as new CRDT operations.

**Why not `Y.applyUpdate()`?** Applying an old Yjs
state update to the current doc _merges_ rather than
_replaces_ — the old state is a subset of the current
state, so it's a no-op or creates merge artifacts. You
must read old content and write it as new CRDT
operations.

---

## Local Persistence and Encryption-at-Rest

`y-indexeddb` stores raw Yjs updates in the browser's
IndexedDB — one store per channel. **This data is
unencrypted at rest.** The encrypted IPFS snapshots
protect data in transit and at rest on pinners, but a
compromised device gives full access to document
content via IndexedDB without needing the URL fragment.

### If device compromise is in your threat model

1. **Encrypt before IndexedDB** — wrap `y-indexeddb`
   with a layer that encrypts using a key derived from
   the URL fragment or a user passphrase
2. **Non-extractable Web Crypto key** — prevents
   JS-level exfiltration of the key itself, though
   decrypted data is still in memory
3. **Accept the risk** — for most scenarios, the URL
   fragment is already in browser history

---

## Revocation

Revocation is **forward-only** — you cannot prevent a
peer from reading history they already fetched.

1. Generate new `adminSecret` → new keypairs → new
   IPNS name → new URLs
2. Share new URLs only with peers who retain access
3. Publish a forwarding record from the old IPNS name

### Forwarding records

When the old IPNS name is still writable, the admin
publishes a forwarding record signed by `rotationKey`:

```ts
{ movedTo: newIpnsName, newReadKey?: ... }
```

**When the old IPNS name is frozen (seq freeze
attack):** In-protocol forwarding is impossible.
Recovery options:

- **Well-known IPFS path:** Publish a signed forwarding
  record to a deterministic CID derived from the old
  IPNS name
- **DNS TXT record:** `_collab-forward.${ipnsName}`
- **Out-of-band notification:** Email, chat, etc.
- **Application-level registry:** Old-name → new-name
  lookup table
