# P2P Collaborative Text Editor — Architecture Reference

A serverless, encrypted, peer-to-peer collaborative document sync library using Yjs subdocuments, WebRTC, IndexedDB, and Helia/IPFS for offline persistence. Designed to be dropped into any Yjs-aware editor (TipTap, ProseMirror, CodeMirror, etc.) with minimal integration surface. Namespace write enforcement is structural: each namespace is a separate Yjs subdocument synced over its own y-webrtc room, and peers only join rooms for namespaces they can write to. Read-only access to all namespaces is delivered via IPNS pubsub-driven snapshot updates.

---

## Core Principles

- **No privileged server** — peers sync directly via WebRTC; pinning servers are permission-less and fungible
- **Encryption** is symmetric, derived from a shared secret in the URL fragment, invisible to any relay or pinner
- **Document identity** is an IPNS name (public key hash) in the URL path, stable across snapshot updates
- **Capability levels** are encoded in the URL fragment as a set of namespace access keys over n namespaces
- **`canPushSnapshots` is an independent trust flag** — not implied by any namespace set, granted explicitly
- **Pinning servers** store and serve encrypted blobs they can't read; anyone can run one
- **Pinners are structurally zero-knowledge** — they validate block structure and signatures but cannot verify authorization (which keys are _allowed_), because that requires decrypting `_meta` with `readKey`
- **App namespacing** is a public string baked into key derivation — not a secret, not authentication
- **Recoverability is structural** — every IPFS snapshot is a complete, self-sufficient document state
- **Namespace enforcement is structural** — each namespace is a separate Yjs subdocument with its own y-webrtc room; peers only join rooms for namespaces they can write to, so unauthorized writes are impossible at the transport level
- **Read access is all-or-nothing and snapshot-driven** — `readKey` decrypts all namespaces; peers receive read-only namespace updates via IPNS pubsub-triggered snapshot fetches, not WebRTC, so read latency equals snapshot interval
- **The library has no opinion on content** — it enforces which namespace access key gates which subdocument; what lives in those subdocuments is entirely the application's business
- **The library has no opinion on snapshot timing** — it exposes `pushSnapshot()` and emits `snapshot-recommended`; when to call it is application policy

---

## Recoverability Guarantees

These guarantees hold regardless of which peers are online, which capability levels are in play, or how many snapshots exist in the chain.

**Each snapshot is a full `Y.encodeStateAsUpdate` per subdocument** — a complete Yjs state for every namespace, not a delta. Any single snapshot CID is independently sufficient to reconstruct the entire document (all subdocuments) at that point in time. The `prev` chain is for version history traversal only — losing any node (or all but one) does not affect recoverability.

**The `prev` chain is append-only and content-addressed.** CIDs are immutable hashes of their content. Nothing in history can be altered or deleted retroactively.

**Yjs CRDT merges are always safe.** Divergent snapshots from peers with different views converge unconditionally when those peers sync over WebRTC.

**Pinners keep 24 hours of snapshot history.** This gives admins a rollback backstop — if a malicious snapshot is published, the admin can use `rotationKey` to manually point IPNS at a known-good CID from within the pinned window, or migrate the document identity entirely if the pointer has been frozen.

**The one real risk is resource exhaustion, not data loss.** Any peer with `ipnsKey` could flood the network with snapshots. This is an availability/cost concern, not a data integrity concern. Pinners rate-limit snapshot ingestion per IPNS name. The social mitigation is: `canPushSnapshots` is a meaningful trust boundary — don't grant it to strangers.

---

## Library API

The library owns sync, persistence, and crypto. The integrating app owns the editor binding, UI, and snapshot timing policy.

```ts
import { createCollabLib } from "your-collab-lib";

// Initialize once. appId is a public namespace string — not a secret.
// namespaces: the set of subdocuments the library manages.
// Each namespace becomes its own Y.Doc. Writable namespaces are synced
// in real-time via y-webrtc; read-only namespaces are updated via
// IPNS pubsub-driven snapshot fetches.
// The application decides what each namespace means — 'comments', 'suggestions',
// 'reactions', 'tracked-changes', etc. The library just enforces access.
const collab = createCollabLib({
  appId: "github.com/yourname/your-editor", // optional
  namespaces: ["content", "comments"], // or just ['content'], or n of anything
});

// Create a new document
const doc = await collab.create();
doc.subdoc("content"); // Y.Doc for the 'content' namespace — pass to editor
doc.subdoc("comments"); // Y.Doc for the 'comments' namespace — pass to comments UI
doc.provider; // for awareness / cursor presence (shared room, ephemeral)
doc.capability; // { namespaces: Set<string>, canPushSnapshots: bool, isAdmin: bool }
doc.adminUrl; // keep private — derives everything
doc.writeUrl; // read + write all namespaces + canPushSnapshots
doc.readUrl; // read only
doc.status; // observable: 'syncing' | 'synced' | 'offline' | 'unpushed-changes'

// Generate a custom capability URL — any subset of namespaces, with or without snapshot pushing
doc.inviteUrl({
  namespaces: ["comments"],
  canPushSnapshots: true, // explicit — not implied by namespace access
});

// Open an existing document — capability inferred from fragment
const doc = await collab.open(url);
doc.subdoc("content"); // Y.Doc — readable by all capability levels
doc.subdoc("comments"); // Y.Doc — readable by all capability levels
doc.capability; // { namespaces: Set<string>, canPushSnapshots: bool, isAdmin: bool }
doc.inviteUrl(capability); // generate lower-privilege URLs
// can only grant subsets of own capability

// Snapshot management — the app owns when this gets called
await doc.pushSnapshot(); // push current state to IPFS, advance IPNS pointer
// no-op if capability.canPushSnapshots is false
// resolves when the snapshot is pinned locally;
// IPNS propagation continues in the background

// The library emits this when the doc has diverged meaningfully from the last
// pushed snapshot — by elapsed time, by operation count, or both (configurable).
// The app decides what to do: start a timer, show a save indicator, whatever.
doc.on("snapshot-recommended", () => {
  // e.g. show a "save" button, or kick off a debounced pushSnapshot()
});

// Full editor integration — the entire app-side surface:
const editor = new Editor({
  extensions: [
    Collaboration.configure({ document: doc.subdoc("content") }),
    CollaborationCursor.configure({ provider: doc.provider }),
  ],
});
```

Read-only peers should not be connected to the content WebRTC room — they receive content updates via IPNS pubsub snapshot fetches. The application should reflect this in the editor configuration:

```ts
const isReadOnly = !doc.capability.namespaces.has("content");
const editor = new Editor({
  editable: !isReadOnly,
  extensions: [
    Collaboration.configure({ document: doc.subdoc("content") }),
    CollaborationCursor.configure({ provider: doc.provider }),
  ],
});
```

### Snapshot timing is the app's responsibility

The library deliberately does not call `pushSnapshot()` automatically on any trigger, including disconnect. The app should:

- Call `pushSnapshot()` on a periodic timer while the document is open
- Attempt `pushSnapshot()` in a `beforeunload` / `visibilitychange` handler (best-effort — see caveats below)
- Optionally show a save indicator tied to `doc.status === 'unpushed-changes'`
- Listen for `snapshot-recommended` as a hint that a push would be timely

### Snapshot frequency affects read-only peer latency

Peers who can only read a namespace (not write to it) receive updates for that namespace via IPNS pubsub-driven snapshot fetches — not via WebRTC. This means **snapshot frequency directly determines how stale read-only content appears to limited-capability peers.**

For apps with comment-only or suggestion-only collaborators who need to see current content while annotating, a snapshot interval of **30–60 seconds during active editing** is a reasonable target. This balances read-only freshness against pinner load and IPFS overhead. The snapshot is event-driven from the read-only peer's perspective: the peer's Helia node is subscribed to the IPNS name's pubsub topic, so it receives the new IPNS record immediately when a trusted peer pushes, then fetches the block from a pinner. There is no polling. Total additional latency beyond the snapshot interval is typically a few seconds (pubsub propagation + pinner fetch).

For apps where all collaborators have write access to all namespaces, snapshot frequency only affects durability (how much work is lost if all peers disconnect) and version history granularity. Lower frequency is fine.

**Recommended defaults for the `snapshot-recommended` event:**

| Scenario                                | Interval | Rationale                           |
| --------------------------------------- | -------- | ----------------------------------- |
| Active editing, read-only peers present | 30–60s   | Keeps read-only content fresh       |
| Active editing, all peers are writers   | 2–5 min  | Durability and version history only |
| Idle (no edits since last snapshot)     | No push  | Avoid unnecessary pinner load       |

**`beforeunload` caveats:** Browsers do not honor async work in `beforeunload` handlers. `e.preventDefault()` triggers the "unsaved changes" dialog but does not block teardown until a promise resolves. On mobile, `beforeunload` may not fire at all. The realistic durability mechanism is periodic saves; `beforeunload` is a best-effort supplement, not a guarantee.

```ts
// Best-effort: warn the user; the actual save should have happened on a timer already.
window.addEventListener("beforeunload", (e) => {
  if (doc.status === "unpushed-changes") {
    e.preventDefault(); // triggers browser "unsaved changes" dialog
  }
});

// visibilitychange is more reliable on mobile for detecting tab/app backgrounding
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "hidden" &&
    doc.status === "unpushed-changes"
  ) {
    doc.pushSnapshot(); // fire-and-forget; may or may not complete
  }
});
```

The library tracks the last-pushed CID and seq internally (needed for `prev` links and seq incrementing regardless), so `status === 'unpushed-changes'` and `snapshot-recommended` are cheap to emit.

---

## URL Structure

```
myapp.com/doc/<ipns-name>#<version-byte><key-material>
```

| Part              | Visibility         | Purpose                                                                                                                                                                                        |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<ipns-name>`     | Public (in path)   | Stable document ID — same across all capability levels. Used as prefix for y-webrtc room names (`${ipnsName}:${namespace}`), IndexedDB DB names, pubsub topic, DHT key.                        |
| `#<version-byte>` | Private (fragment) | Format version — enables future key derivation scheme changes without breaking old URLs.                                                                                                       |
| `<key-material>`  | Private (fragment) | Always contains `readKey` and `awarenessRoomPassword`. Optionally contains `ipnsKey`, `rotationKey`, and any subset of namespace access keys. The set of included keys defines the capability. |

Capability is implicit in which keys are present — the library detects this on `open()` by inspecting which namespace access keys are included in the fragment. If a namespace key is present, the peer can write to that namespace (and joins its y-webrtc room). If only `readKey` is present, the peer is read-only across all namespaces.

---

## Key Derivation

All keys derived from `adminSecret` via HKDF. The `info` parameter encodes both the `appId` and the derivation purpose, following standard HKDF convention (RFC 5869): `info` is the context/purpose differentiator, `salt` is omitted (empty). `appId` is a public namespace string — it identifies which application's key space this document belongs to. It is baked into key derivation to prevent cross-app key collisions, and it defines the pubsub topic (`/app/${appId}/announce`) that pinners subscribe to for automatic document discovery (see Permission-less Pinning Servers). It is not a secret and not used for authentication.

```ts
async function deriveDocKeys(
  adminSecret: string,
  appId: string = "",
  namespaces: string[],
) {
  const raw = new TextEncoder().encode(adminSecret);
  const baseKey = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);

  const makeInfo = (purpose: string) =>
    new TextEncoder().encode(`${appId}:${purpose}`);

  const deriveAES = (purpose: string) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: makeInfo(purpose),
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );

  const deriveBits = (purpose: string) =>
    crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: makeInfo(purpose),
      },
      baseKey,
      256,
    );

  const readKey = await deriveAES("read"); // all levels
  const ipnsKeyBytes = await deriveBits("ipns"); // canPushSnapshots peers
  const rotationKey = await deriveBits("rotation"); // admin only

  // Awareness room password — included at all capability levels so every URL holder can join
  const awarenessRoomPassword = await deriveBits("awareness-room");

  // One namespace access key per namespace, derived from the namespace name.
  // These bytes serve as the y-webrtc room password for that namespace
  // (hex-encoded) — a peer with the access key can join the room.
  const namespaceKeys = Object.fromEntries(
    await Promise.all(
      namespaces.map(async (ns) => [ns, await deriveBits(`ns:${ns}`)]),
    ),
  );

  return {
    readKey,
    ipnsKeyBytes,
    rotationKey,
    namespaceKeys,
    awarenessRoomPassword,
  };
}
```

### Fragment Key Material

The fragment always contains `readKey` and `awarenessRoomPassword` (both required at every capability level). Beyond that, it contains whichever of `ipnsKey`, `rotationKey`, and namespace access keys that capability grants — serialized as a labeled, length-prefixed list so the library can identify which keys are present on `open()`.

---

## Namespace Enforcement via Subdocuments and Room Isolation

Each namespace is a separate Yjs subdocument (`Y.Doc`) with its own y-webrtc room. Write enforcement is structural: a peer only joins the y-webrtc room for namespaces it has access keys for. Read access to all namespaces is delivered via IPNS pubsub-driven snapshot fetches.

### Sync architecture

For each namespace in the peer's capability set (`doc.capability.namespaces`), the library creates a `WebrtcProvider` connecting to a room named `${ipnsName}:${namespace}`. This gives the peer real-time bidirectional CRDT sync for that namespace — standard y-webrtc, no custom protocol.

For namespaces the peer can only read (not in its capability set), the library does **not** connect to the WebRTC room. Instead:

1. On connect, the peer loads the latest IPFS snapshot and applies each read-only subdoc's state via `Y.applyUpdate`
2. The peer's Helia node subscribes to the IPNS name's pubsub topic (already required for snapshot discovery)
3. When a trusted peer pushes a new snapshot, the IPNS pubsub delivers the new record immediately
4. The library fetches the new snapshot block via Helia (typically from a pinner) and applies the updated subdoc states

> **Implementation note: snapshot fetch coalescing.** There is a non-trivial interaction between IPNS pubsub update frequency and block propagation latency. During active editing with frequent snapshots, the read-only peer may receive multiple IPNS pubsub notifications (CID_n, CID_n+1, CID_n+2...) before any single fetch completes. Since every snapshot is full state, any successfully fetched snapshot is a valid update.
>
> IPFS block fetching does not provide a fast "not found" response. Provider discovery (DHT walk or delegated routing) can take seconds to tens of seconds before concluding that no provider has the block yet. A sequential fallback strategy (try newest, timeout, try next-oldest) would burn through the entire snapshot interval on timeouts alone.
>
> Recommended approach: **concurrent fetches, first-success-wins.** Maintain an ordered list of known CIDs from pubsub notifications (newest first). When a new CID arrives, immediately start fetching it. Keep up to 2–3 concurrent fetch requests in flight (the most recent known CIDs). The first fetch to return a block wins — apply `Y.applyUpdate` for all subdocs from that snapshot, cancel all other in-flight requests, and prune the CID list of anything older than the successfully applied snapshot. When a new pubsub notification arrives, prepend the new CID to the list, start fetching it, and cancel the oldest in-flight fetch if the concurrency limit is exceeded.
>
> This means CID_n (which has had the most time to propagate to pinners) may resolve before CID_n+2 (which was just published). That's fine — the peer gets a slightly older but still valid full state, and the next successful fetch will bring it forward. The Yjs CRDT merge ensures correctness regardless of which snapshot the peer lands on or what order they arrive in. The library should not surface transient fetch failures to the application; the read-only subdoc simply stays at its previous state until a fetch succeeds.

This is event-driven, not polling. Read-only latency equals the snapshot push interval — during active editing with 30–60 second snapshots, this is the staleness window for read-only namespaces.

Awareness (cursor presence, selection state) is shared via a lightweight y-webrtc room on a dummy Y.Doc that carries no content. All peers join this room regardless of capability level. The room is password-protected using `awarenessRoomPassword` (included in every capability URL) — every legitimate peer can join, but an observer who only knows the IPNS name cannot eavesdrop on presence information.

### Why this is structural

A peer without the access key for a namespace never joins that namespace's WebRTC room. There is no code path — honest or malicious — through which they can inject mutations into the real-time sync for that namespace. y-webrtc is unmodified; enforcement comes from room membership, not from intercepting messages.

A malicious client could attempt to connect to a room it shouldn't have access to. y-webrtc rooms are identified by name, so a peer could construct the room name and subscribe to it on the signaling server. However, the room uses y-webrtc's `password` option, set to the hex-encoded namespace access key bytes (see Key Derivation). The password is used to derive a `CryptoKey` that encrypts all signaling messages (SDP offers, answers, ICE candidates). A peer without the correct access key cannot produce the correct password, cannot decrypt incoming signaling messages from legitimate peers, and its own incorrectly-encrypted signaling messages are rejected by legitimate peers (decryption fails silently). Since the WebRTC SDP exchange cannot complete, no peer connection is established, and no data channel exists to sync over. This is the structural enforcement mechanism — the access key gates the room password, the password gates signaling, and without signaling, the WebRTC connection is physically impossible.

> **Note:** WebRTC data channel messages are not application-layer encrypted by y-webrtc (they rely on WebRTC's built-in DTLS transport encryption). This is fine — the access control boundary is at connection establishment, not at the message level. If a peer somehow obtained a valid data channel connection (which requires the password), they're authorized.

An alternative design would use a single shared `Y.Doc` with namespace enforcement as a library-level convention: the library wraps updates in signed envelopes, but the raw `Y.Doc` is exposed to the application and to y-webrtc, so a malicious client could bypass signing entirely and propagate unsigned mutations. That approach is cooperative — it works as long as every peer runs honest code, but a single malicious client (or a malicious fork of the library) could break enforcement for every deployment. The subdocument + room isolation design avoids this entirely.

### Read-only peers

A peer with only `readKey` (no namespace access keys) joins no content rooms — only the awareness room. It receives all subdoc content from IPFS snapshots, updated via IPNS pubsub whenever a trusted peer pushes. The application should set the editor to read-only mode (`editable: false` in TipTap, `readOnly` in CodeMirror, etc.).

Read-only content is not real-time — it updates at snapshot frequency. For a commenter viewing content while annotating, this is typically fine: comments anchor via `Y.RelativePosition` against the local content state, and the positions resolve correctly regardless of minor staleness.

### Cross-namespace references

Annotation namespaces (comments, suggestions, tracked changes) reference positions in the content namespace using Yjs `Y.RelativePosition`. Creating a RelativePosition reads from the content subdoc (available to all peers) and stores it in the annotation subdoc (writable by the annotator). This requires no content write access — it's a read from one subdoc and a write to another.

### `_meta` as a subdocument

`_meta` is itself a subdocument with its own y-webrtc room. The room password is derived from the primary namespace's access key (e.g., hex of `HKDF(primaryAccessKey, info: '_meta_room')`), so only peers who can write to the primary namespace can join the `_meta` room. It holds access allowlists and configuration. The library manages `_meta` internally; the application never receives a writable reference to it.

---

## `_meta` Structure and CRDT Merge Semantics

`_meta` is a dedicated subdocument that holds access allowlists and configuration. It has its own y-webrtc room, accessible only to peers with the primary namespace's access key.

### Structure

```ts
// _meta is its own Y.Doc, managed internally by the library
const meta = doc.metaDoc; // not exposed to the application

// Access allowlists: one Y.Array per namespace, containing public key bytes.
// In the room-isolation architecture, these are NOT the enforcement mechanism
// (room passwords handle that). They serve as an admin bookkeeping tool —
// tracking which keys have been granted access to which namespace,
// which is needed for revocation (knowing which keys to rotate away from).
meta.getMap("authorized").get("content"); // Y.Array<Uint8Array>
meta.getMap("authorized").get("comments"); // Y.Array<Uint8Array>

// Snapshot push allowlist — peers verify snapshot signatures against this
// when loading from IPFS (the one place where signature verification still applies)
meta.getArray("canPushSnapshots"); // Y.Array<Uint8Array> — ipnsKey public keys
```

### Merge behavior

`_meta` is subject to Yjs CRDT merge rules. In practice this is a non-issue: admin operations (adding/removing keys, forwarding to a new document) should be coordinated out-of-band between admins. Concurrent admin modifications merge safely at the CRDT level (no data loss, no crash), and the risk of conflicting revocations is mitigated by the fact that admin actions are rare and deliberate.

---

## IPFS Persistence: Linked-List Snapshot DAG

Each snapshot contains the full state of every subdocument, encoded independently.

```ts
interface SnapshotNode {
  subdocs: {
    // one entry per namespace + _meta
    [namespace: string]: // e.g. 'content', 'comments', '_meta'
    Uint8Array; // Y.encodeStateAsUpdate — complete encrypted state for this subdoc
  };
  prev: CID | null; // link to previous snapshot
  seq: number; // monotonically increasing for IPNS ordering
  ts: number; // unix timestamp
  signature: Uint8Array; // signs (subdocs | prev | seq | ts) with ipnsKey
  publicKey: Uint8Array; // ipnsKey public key — verifiable against canPushSnapshots allowlist
}
```

```
IPNS name
  └─> CID_n (latest) ──prev──> CID_n-1 ──prev──> ... ──prev──> CID_1 (null)

Any single CID = complete document recovery (all subdocs)
prev chain = version history only, not load-bearing for recoverability
```

---

## IPNS Routing: Pubsub + DHT

| Router | Speed     | Persistence              | Use                                                        |
| ------ | --------- | ------------------------ | ---------------------------------------------------------- |
| Pubsub | Immediate | Ephemeral                | Fast propagation to online pinners **and read-only peers** |
| DHT    | ~seconds  | Persistent, expires ~24h | Cold bootstrap                                             |

Use both simultaneously. Pinners re-publish DHT records every ~12 hours to prevent expiry.

IPNS pubsub serves double duty: it notifies pinners of new snapshots to pin, and it notifies read-only peers that new content is available to fetch. Both receive the IPNS record update immediately when a trusted peer publishes. The read-only peer then resolves the new CID via Helia — in practice, fetching the block from a pinner that has already ingested it on the same pubsub notification. Total latency for a read-only peer is snapshot interval + IPNS pubsub propagation (sub-second) + block fetch from pinner (network-dependent, typically a few seconds).

---

## Permission-less Pinning Servers

Pinners are structurally zero-knowledge. They never possess `readKey` and cannot decrypt document content or `_meta`. A pinner is configured with one or more `appId` values and automatically discovers and pins all documents created by any user of those apps — no per-document setup required.

### Discovery

When a peer creates a document or pushes a snapshot, the library publishes an announcement to the app-level pubsub topic `/app/${appId}/announce` containing the document's IPNS name. Pinners subscribed to that topic discover the document automatically. This is the primary discovery path — it's immediate and requires no coordination between the document creator and the pinner operator.

As a secondary path, pinners also discover IPNS names via DHT provider records (slower, but works for documents whose creators are no longer online). Pinners should periodically crawl DHT provider records for IPNS names they haven't seen via pubsub.

### Jobs

Once a pinner discovers an IPNS name, its ongoing jobs are:

1. Resolve IPNS name → verify snapshot signature is structurally valid (well-formed Ed25519) → pin the block
2. **Keep all snapshots from the last 24 hours** — time-windowed, not count-based
3. Prune snapshots older than 24 hours (always keep the tip regardless of age)
4. Re-publish DHT IPNS record every ~12 hours

### What pinners can and cannot verify

Pinners **can** verify:

- The snapshot block is valid CBOR with the expected schema
- The Ed25519 signature is valid over the block contents
- The block size is within limits
- Rate limits are not exceeded

Pinners **cannot** verify:

- Whether the publishing key is authorized (that information is in encrypted `_meta`)
- Whether the snapshot content is legitimate vs. malicious
- Anything about the document content

This is a deliberate design choice. Giving pinners `readKey` would let them read all document content, collapsing the zero-knowledge property. The tradeoff is that pinners will pin snapshots from _any_ holder of `ipnsKey`, authorized or not. This is acceptable because `canPushSnapshots` is already a trust boundary — if `ipnsKey` leaks, the mitigation is admin-initiated rotation, not pinner-side enforcement.

### Rate Limiting

Pinners protect their own resources with per-IPNS-name rate limiting:

```ts
const RATE_LIMIT = {
  maxSnapshotsPerHour: 60, // one per minute sustained — generous for legitimate use
  maxBlockSizeBytes: 5_000_000, // 5MB per snapshot — adjust to expected doc sizes
};
```

A sustained snapshot flood is expensive for an attacker and bounded for the pinner. Rate limiting is the pinner protecting itself — it doesn't affect the permission-less model since any pinner sets its own limits independently.

### Infrastructure

Delegated routing defaults to `delegated-ipfs.dev`, Protocol Labs' well-maintained public infrastructure — a reasonable default, analogous to using a public DNS resolver. Self-hostable via `someguy` if operational independence is required.

Bootstrap peers default to the standard libp2p bootstrap list, also Protocol Labs-operated. Once connected, peer discovery is organic through the DHT — bootstrap nodes are only needed for initial network entry.

### Lean Configuration

```ts
const libp2p = await createLibp2p({
  connectionManager: { maxConnections: 20, minConnections: 5 },
  peerDiscovery: [],
  nat: { enabled: false },
});
const helia = await createHelia({
  libp2p,
  routers: [delegatedHTTPRouting("https://delegated-ipfs.dev")],
});
```

Bandwidth at steady state is near-zero. Suitable for homelab behind standard NAT. Behind CGNAT, degrades gracefully to pinning + IPNS publishing (can't serve blocks inbound, other pinners cover it).

---

## Local Persistence and Encryption-at-Rest

`y-indexeddb` stores raw Yjs updates in the browser's IndexedDB — one store per subdocument. **This data is unencrypted at rest.** The encrypted IPFS snapshots protect data in transit and at rest on pinners, but a compromised device (physical access, malicious extension, XSS) gives full access to document content via IndexedDB without needing the URL fragment.

### If device compromise is in your threat model

Options for encrypting the local store:

1. **Encrypt before IndexedDB** — wrap `y-indexeddb` (or replace it) with a layer that encrypts updates using a key derived from the URL fragment or a user passphrase. The tradeoff: the key must be available at page load to hydrate the editor, which means either prompting the user or caching the key somewhere (which moves the problem).
2. **Use the Web Crypto API with a non-extractable key** — import `readKey` as non-extractable into the browser's key store. This prevents JS-level exfiltration of the key itself, though the decrypted data is still in memory.
3. **Accept the risk** — for most collaborative editing scenarios, the URL fragment (which is the full capability token) is already stored in browser history, bookmarks, or a link the user clicked. An attacker with device access likely has the URL too. Encrypting IndexedDB raises the bar but doesn't eliminate the threat.

The library should document this tradeoff and optionally support an encrypted persistence adapter. The default (`y-indexeddb` as-is) is a reasonable starting point for most use cases.

---

## Version History

Version history falls out of the persistence design with no additional infrastructure:

1. Resolve IPNS → tip CID
2. Walk `prev` links → timeline of `{ cid, seq, ts }` tuples
3. User scrubs to a point → fetch that CID, decrypt, `Y.applyUpdate` each subdoc into throwaway docs, render read-only

`ts` gives human-readable timeline; `seq` gives reliable ordering if clocks are skewed. Recently-visited snapshots are already in Helia's local blockstore. The 24-hour pinner window means recent history is reliably available even across all-peers-offline gaps.

Snapshot granularity is coarse (application-controlled) — history shows versions, not per-keystroke replay. Fine-grained undo within a session is Yjs's in-memory undo stack, orthogonal to this.

---

## Revocation

Revocation is **forward-only** — you cannot prevent a peer from reading history they already fetched.

1. Generate new `adminSecret` → new keypairs → new IPNS name → new URLs
2. Share new URLs only with peers who retain access
3. Publish a forwarding record from the old IPNS name (see caveats below)

### Forwarding records

When the old IPNS name is still writable (the `ipnsKey` holder hasn't performed a seq freeze), the admin publishes a forwarding record signed by `rotationKey`:

```ts
{ movedTo: newIpnsName, newReadKey?: ... }
```

`rotationKey` signature proves authenticity — only the original admin could produce it.

**When the old IPNS name is frozen (seq freeze attack):** The admin cannot publish a new IPNS record — that's the definition of the attack. In-protocol forwarding is impossible. Recovery requires an out-of-band mechanism:

- **Well-known IPFS path:** Publish a signed forwarding record to a deterministic CID derived from the old IPNS name (e.g., hash of `forwarding:${oldIpnsName}`). Peers that detect a frozen IPNS name check this path.
- **DNS TXT record:** If the app has a domain, publish a `_collab-forward.${ipnsName}.example.com` TXT record.
- **Out-of-band notification:** Email, chat, or any channel the admin uses to reach collaborators.
- **Application-level registry:** The app maintains a lookup table of old-name → new-name mappings (requires some centralization, which may be acceptable at the application layer).

The library should implement the well-known IPFS path as a default discovery mechanism, with the understanding that it requires at least one peer or pinner to serve the forwarding block.

---

## Threat Model

### Threat 1: Peer forges an update to a namespace they don't have access to

Each namespace is a separate y-webrtc room, password-protected using the namespace access key bytes. A peer without the access key cannot derive the room password, cannot complete the signaling handshake, and therefore cannot establish a WebRTC connection to inject updates. **Structurally protected** — enforcement is at connection establishment via room isolation, not by filtering messages.

### Threat 2: Peer replays a captured update from another peer

y-webrtc syncs in a mesh — every peer in a room receives every sync message over its own data channel connections. A room member can capture a message from another peer and re-send it. However, replaying a previously observed Yjs sync message is idempotent — CRDT state doesn't change. **Protected by CRDT properties.**

### Threat 3: Peer escalates by modifying `_meta`

`_meta` is a subdocument in its own password-protected y-webrtc room, accessible only to peers with the primary namespace's access key. A limited-namespace peer cannot join the `_meta` room. **Structurally protected.**

### Threat 4: Malicious `ipnsKey` holder

**Residual risk — two forms, unified mitigation.**

Any peer with `ipnsKey` (`canPushSnapshots`) can abuse it in two distinct ways:

**Form A — Malicious snapshot.** The attacker publishes a crafted snapshot: either stale state with `prev: null` (severing the history chain), or synthesized Yjs tombstones for content they never legitimately received. Peers with local IndexedDB state are unaffected — CRDT merge corrects on next sync, and the next legitimate snapshot overwrites the bad tip. The dangerous case is a peer cold-bootstrapping with no live peers available; they load corrupted state until they connect to a legitimate peer. _Recovery:_ admin uses `rotationKey` to point IPNS at a known-good CID from the pinner's 24-hour history window. Disruptive but recoverable in-place — the IPNS name survives.

**Form B — seq freeze.** The attacker publishes an IPNS record with `seq = 2^64 - 1` (the protocol maximum). DHT nodes and peers accept it as canonical and will never accept a higher record — the IPNS pointer is permanently frozen. There is no in-place recovery; the old IPNS name is dead. _Recovery:_ admin generates a new `adminSecret`, derives a new IPNS keypair, gets a new IPNS name. In-protocol forwarding from the old name is impossible (that's the attack). The library checks a well-known IPFS forwarding path derived from the old IPNS name; the admin publishes a `rotationKey`-signed forwarding record there. Peers that detect the freeze discover the new location via this path or via out-of-band communication. Full document identity migration required.

**Unified mitigation:**

- `canPushSnapshots` is an explicit trust grant — don't give it to strangers
- Pinners keep 24 hours of history for Form A rollback
- Pinner rate limiting (max N snapshots/hour per IPNS name) bounds flood cost
- `rotationKey` enables recovery from both forms; Form B requires full identity migration via out-of-band or well-known-path discovery

### Threat 5: External attacker (no URL)

Can observe IPNS names and fetch encrypted blocks. Cannot decrypt, forge, or publish. **Fully locked out.**

### Threat 6: Pinning server misbehaves

Can observe IPNS names and encrypted blocks (neither sensitive). Can refuse to pin (DoS, covered by other pinners). Can serve a stale snapshot (degraded bootstrap, not data loss — CRDT merge corrects on peer connect). Cannot decrypt or forge. **Tolerable worst case.**

### Threat 7: Signaling server misbehaves

Can observe which IPNS names are active as WebRTC rooms (already public). Can block connections (DoS). Cannot read content. **Tolerable worst case.**

### Threat 8: URL leak

Whoever finds the URL has that capability level — the URL is the capability token. Mitigation is admin-initiated rotation via `rotationKey`.

### Threat 9: Device compromise

An attacker with access to the device can read IndexedDB contents (unencrypted Yjs state) and likely recover the URL fragment from browser history. **Not protected by default.** See Local Persistence and Encryption-at-Rest for mitigation options.

---

## Signaling

y-webrtc requires signaling to broker WebRTC connections
(SDP/ICE exchange). Never sees document content. Once
signaling exchanges SDP/ICE, WebRTC connections are direct
peer-to-peer.

**Primary: GossipSub via Helia/libp2p.** Each peer runs a
Helia node with `@chainsafe/libp2p-gossipsub` as a pubsub
service. The GossipSub signaling adapter
(`packages/sync/src/gossipsub-signaling.ts`) implements the
y-webrtc `SignalingConn` interface by extending
`lib0/observable.Observable`. It registers in y-webrtc's
`signalingConns` map under the key `"libp2p:gossipsub"`.

All rooms share a single GossipSub topic
(`/pokapali/signaling`); room routing happens via the room
name in the JSON payload. This avoids per-room topic
overhead and keeps mesh health simple. GossipSub is
configured with `floodPublish: true` to prevent mesh
degradation on low-traffic topics. Periodic re-announce
(every 15 s) ensures late-joining peers discover existing
rooms.

Relay nodes subscribe to the signaling topic and forward
messages between browsers. Browsers discover relays via
DHT (looking up a CID derived from `appId`) and cached
relay addresses in `localStorage`.

Two browsers sharing the same document URL can collaborate
with zero self-hosted infrastructure — only public
IPFS/libp2p bootstrap nodes are needed for initial peer
discovery.

**Optional: WebSocket signaling servers.** Traditional
y-webrtc WebSocket signaling (`wss://signaling.yjs.dev`,
self-hosted ~30-line server) remains available as an
optional parallel path. If `signalingUrls` are provided,
y-webrtc connects to those servers in addition to the
GossipSub channel. This provides faster initial connection
in environments where libp2p bootstrap is slow, or as a
fallback when libp2p connectivity is limited.

---

## Bundle Size Considerations

Helia + libp2p is not a lightweight dependency. Expect 500KB+ minified/gzipped for the full IPFS stack. For a library positioned as a "drop-in," overall bundle size is a meaningful cost that applications should budget for. y-webrtc itself is lightweight (~15KB); the IPFS stack is the main contributor.

Possible mitigations:

- **Lazy-load Helia** — for write-capable peers, the editor is functional with just Yjs + y-webrtc + y-indexeddb (~30KB). Load Helia asynchronously for snapshot push/pull. For read-only peers, Helia is required at startup (they receive content via IPFS snapshots), so lazy-loading is less applicable.
- **Pinning-only mode** — for apps that don't need offline cold-bootstrap or version history, skip the full IPFS stack entirely. Use a lightweight HTTP API to push snapshots to a pinning server directly. The pinner still stores encrypted blobs; the client just doesn't run a full IPFS node.
- **Tree-shaking** — Helia is modular. Only import the routers, block codecs, and transports actually used.

The library should document expected bundle sizes for each configuration tier.

---

## Dependency Summary

| Package                                       | Purpose                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `yjs`                                         | CRDT engine; subdocument support for namespace isolation                           |
| `y-webrtc`                                    | P2P real-time sync — one room per writable namespace, plus a shared awareness room |
| `y-indexeddb`                                 | Local persistence in browser (per-subdoc)                                          |
| `helia`                                       | IPFS in browser and pinner; delivers read-only namespace updates via IPNS pubsub   |
| `@helia/dag-cbor`                             | IPFS block encoding for snapshots                                                  |
| `@helia/ipns`                                 | IPNS publish/resolve                                                               |
| `@helia/delegated-routing-v1-http-api-client` | Lean routing for pinner                                                            |
| `@chainsafe/libp2p-gossipsub`                 | GossipSub pubsub for libp2p — primary signaling channel for WebRTC SDP/ICE relay  |
| `@libp2p/crypto/keys`                         | IPNS keypair derivation                                                            |
| `@tiptap/*`                                   | Example editor integration (app-side, not in library)                              |

---

## Future Extensions

### Per-user identity within namespaces

The current design treats all peers with the same namespace access key as equal — anyone in the `comments` room can edit or delete anyone else's comments. This is acceptable for a v1 among trusted collaborators, but a natural next step is per-user identity.

The migration path is purely additive and does not require changes to room isolation, URL structure, key derivation, or the snapshot format:

1. Each user generates a keypair client-side (e.g., Ed25519)
2. The user's public key is registered in `_meta` under the namespace (the `authorized` map already stores public key bytes per namespace — this is where user identities would go)
3. When the user creates or edits an entry within a subdoc, the entry includes their public key and a signature
4. The application layer enforces "you can only edit entries you authored" by checking signatures against registered public keys

This is cooperative enforcement at the intra-namespace level (peers trust each other's clients to check signatures), but the trust surface is much smaller than the original single-Y.Doc design — you're trusting peers not to mess with each other's comments, not trusting them with the entire document. The room password still provides the structural access boundary.

This could also evolve toward DIDs, UCANs, or other external identity layers without changing the room-isolation architecture.

**Application guidance to preserve this path:** within annotation namespaces (comments, suggestions, etc.), store entries as `Y.Map` instances with room for metadata fields (author public key, signature, timestamps) rather than bare strings in a `Y.Array`. This keeps the door open for per-user identity without a data migration.

---

P2P systems are inherently difficult to integration-test — there's no central server to assert against, and behavior depends on the combination of peers, capability levels, network timing, and CRDT merge order. Plan for this early; retrofitting a test harness onto a P2P library is painful.

The library should include a test harness that spins up multiple in-process Yjs/Helia nodes with different capability URLs — e.g., one admin, one content+comments writer, one comments-only writer, one read-only peer — and exercises the core invariants: namespace isolation (a comments-only peer's local content mutations don't propagate), snapshot round-tripping (push a snapshot, cold-bootstrap a new peer from it, verify state), CRDT merge convergence (two writers edit concurrently, verify all peers converge), read-only delivery (push a snapshot, verify read-only peer receives it via IPNS pubsub), and revocation (rotate keys, verify old-capability peers are locked out of new rooms). The snapshot fetch coalescing logic (concurrent fetches, first-success-wins, CID list pruning) deserves its own unit tests with simulated fetch latencies.
