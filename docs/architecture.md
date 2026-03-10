# P2P Collaborative Text Editor — Architecture Reference

A serverless, encrypted, peer-to-peer collaborative document sync library using Yjs subdocuments, WebRTC, IndexedDB, and Helia/IPFS for offline persistence. Designed to be dropped into any Yjs-aware editor (TipTap, ProseMirror, CodeMirror, etc.) with minimal integration surface. Namespace write enforcement is structural: each namespace is a separate Yjs subdocument synced over its own y-webrtc room, and peers only join rooms for namespaces they can write to. Read-only access to all namespaces is delivered via GossipSub-announced and IPNS-polled snapshot updates.

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
- **Read access is all-or-nothing and snapshot-driven** — `readKey` decrypts all namespaces; peers receive read-only namespace updates via GossipSub-announced and IPNS-polled snapshot fetches, not WebRTC, so read latency equals snapshot interval
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
// GossipSub-announced and IPNS-polled snapshot fetches.
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
doc.status; // observable: 'connecting' | 'synced' | 'receiving' | 'offline'
doc.saveState; // observable: 'saved' | 'dirty' | 'saving' | 'unpublished'

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

Read-only peers should not be connected to the content WebRTC room — they receive content updates via GossipSub-announced and IPNS-polled snapshot fetches. The application should reflect this in the editor configuration:

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
- Optionally show a save indicator tied to `doc.saveState`
- Listen for `snapshot-recommended` as a hint that a push would be timely

### Snapshot frequency affects read-only peer latency

Peers who can only read a namespace (not write to it) receive updates for that namespace via GossipSub-announced and IPNS-polled snapshot fetches — not via WebRTC. This means **snapshot frequency directly determines how stale read-only content appears to limited-capability peers.**

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
  if (doc.saveState === "dirty") {
    e.preventDefault(); // triggers browser "unsaved changes" dialog
  }
});

// visibilitychange is more reliable on mobile for detecting tab/app backgrounding
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "hidden" &&
    doc.saveState === "dirty"
  ) {
    doc.pushSnapshot(); // fire-and-forget; may or may not complete
  }
});
```

The library tracks the last-pushed CID and seq internally (needed for `prev` links and seq incrementing regardless), so `saveState` transitions and `snapshot-recommended` are cheap to emit.

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

Each namespace is a separate Yjs subdocument (`Y.Doc`) with its own y-webrtc room. Write enforcement is structural: a peer only joins the y-webrtc room for namespaces it has access keys for. Read access to all namespaces is delivered via IPNS-resolved and GossipSub-announced snapshot fetches.

### Sync architecture

For each namespace in the peer's capability set (`doc.capability.namespaces`), the library creates a `WebrtcProvider` connecting to a room named `${ipnsName}:${namespace}`. This gives the peer real-time bidirectional CRDT sync for that namespace — standard y-webrtc, no custom protocol.

`SyncManager` listens for y-webrtc `"status"` events on each provider and exposes `onStatusChange(cb)` so that `@pokapali/core` can re-compute `doc.status` whenever the underlying WebRTC connection state changes (e.g., after PBKDF2 key derivation completes and rooms are created). `aggregateStatus` uses **any-connected** semantics: if at least one provider is connected, status is `"connected"`. This is correct because partial writers (with access to a subset of namespaces) may have some rooms with peers and others empty — the empty rooms don't indicate a broken connection.

### Document status model

`doc.status` reflects **connectivity** as a composite of
three transport layers:

```ts
type DocStatus =
  | "connecting"  // bootstrapping, no transport ready
  | "synced"      // WebRTC connected to ≥1 namespace room
  | "receiving"   // no WebRTC peers, but GossipSub active
  | "offline";    // no transports active
```

The derivation considers WebRTC namespace providers,
awareness room connectivity, and GossipSub liveness
(a 60-second recency window on received messages, with
a 30-second decay timer):

1. If any namespace WebRTC provider is connected → `"synced"`
2. If namespace providers are connecting → `"connecting"`
3. If the awareness room is connected or a GossipSub
   message was received within 60 seconds → `"receiving"`
4. If subscribed to GossipSub but no recent messages →
   `"connecting"`
5. Otherwise → `"offline"`

The `"receiving"` state is the typical reader state:
readers have no namespace providers (empty capability
set), but they actively receive snapshot updates via
GossipSub and cursor presence via the awareness room.

**Save state** is tracked separately from connectivity:

```ts
type SaveState =
  | "saved"       // snapshot pushed and acked
  | "dirty"       // local changes not yet pushed
  | "saving"      // push in progress
  | "unpublished"; // no snapshot pushed yet (new doc)
```

Exposed as `doc.saveState`. This separation lets the UI
show a connection indicator and a save indicator
independently.

All clients — writers **and** readers — resolve IPNS on `open()` to load the latest snapshot from the network (non-blocking; Yjs CRDT merge is safe). Writers need this for recovery after all tabs close. Both also watch for live updates via two channels:

1. **GossipSub announcements** (primary, instant): writers publish `{ "ipnsName", "cid" }` on `/pokapali/app/{appId}/announce` after each `pushSnapshot()`. All clients subscribe and apply snapshots directly from the announced CID.
2. **IPNS polling** (fallback, 30s interval): catches updates when no GossipSub peers are connected.

For namespaces the peer can only read (not in its capability set), the library does **not** connect to the WebRTC room. The peer receives all subdoc content from snapshot updates (announced or polled). Block fetches use exponential backoff retry (6 retries, 2s base, 15s timeout per attempt) to handle IPFS propagation latency. Transient fetch failures are retried at the outer level (30s intervals, max 10 attempts) before the snapshot watcher enters a terminal `"failed"` state. On permanent failure, the library calls `markReady()` so the editor mounts with whatever state is available rather than showing a loading screen forever.

After successfully applying a remote snapshot, **all clients** (not just writers) store the fetched block in their Helia blockstore (`blockstore.put`) and re-announce the CID on the GossipSub announce topic. This makes every connected peer — including read-only peers — a block provider via bitswap and a propagation amplifier via GossipSub. The block is content-addressed (can't be forged) and encrypted (no plaintext leak), so this is safe regardless of capability level. Block availability is session-scoped (Helia uses `MemoryBlockstore` by default; blocks do not persist across tab close).

Read-only latency equals the snapshot push interval — during active editing with 30–60 second snapshots, this is the staleness window for read-only namespaces.

Awareness (cursor presence, selection state) is shared via a lightweight y-webrtc room on a dummy Y.Doc that carries no content. All peers join this room regardless of capability level. The room is password-protected using `awarenessRoomPassword` (included in every capability URL) — every legitimate peer can join, but an observer who only knows the IPNS name cannot eavesdrop on presence information.

### Why this is structural

A peer without the access key for a namespace never joins that namespace's WebRTC room. There is no code path — honest or malicious — through which they can inject mutations into the real-time sync for that namespace. y-webrtc is unmodified; enforcement comes from room membership, not from intercepting messages.

A malicious client could attempt to connect to a room it shouldn't have access to. y-webrtc rooms are identified by name, so a peer could construct the room name and join the GossipSub signaling topic. However, the room uses y-webrtc's `password` option, set to the hex-encoded namespace access key bytes (see Key Derivation). The password is used to derive a `CryptoKey` that encrypts all signaling messages (SDP offers, answers, ICE candidates). A peer without the correct access key cannot produce the correct password, cannot decrypt incoming signaling messages from legitimate peers, and its own incorrectly-encrypted signaling messages are rejected by legitimate peers (decryption fails silently). Since the WebRTC SDP exchange cannot complete, no peer connection is established, and no data channel exists to sync over. This is the structural enforcement mechanism — the access key gates the room password, the password gates signaling, and without signaling, the WebRTC connection is physically impossible.

> **Note:** WebRTC data channel messages are not application-layer encrypted by y-webrtc (they rely on WebRTC's built-in DTLS transport encryption). This is fine — the access control boundary is at connection establishment, not at the message level. If a peer somehow obtained a valid data channel connection (which requires the password), they're authorized.

An alternative design would use a single shared `Y.Doc` with namespace enforcement as a library-level convention: the library wraps updates in signed envelopes, but the raw `Y.Doc` is exposed to the application and to y-webrtc, so a malicious client could bypass signing entirely and propagate unsigned mutations. That approach is cooperative — it works as long as every peer runs honest code, but a single malicious client (or a malicious fork of the library) could break enforcement for every deployment. The subdocument + room isolation design avoids this entirely.

### Read-only peers

A peer with only `readKey` (no namespace access keys) joins no content rooms — only the awareness room. It receives all subdoc content from IPFS snapshots, updated via GossipSub announcements (instant) and IPNS polling (30s fallback) whenever a trusted peer pushes. The application should set the editor to read-only mode (`editable: false` in TipTap, `readOnly` in CodeMirror, etc.).

Read-only peers participate in gossip propagation: after applying a snapshot, they store the block in their Helia blockstore (making it available to other peers via bitswap) and re-announce the CID on the GossipSub announce topic. This amplifies snapshot availability without requiring write keys — the announcement is just metadata (`{ipnsName, cid}`), and any receiving peer validates the block independently. Writers additionally re-announce on a periodic 30s timer; readers re-announce only once per received snapshot.

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
  seq: number; // Y.Doc clockSum (sum of all state vector clocks) — deterministic IPNS ordering
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

## IPNS Publishing and Resolution

### Publishing

Writers publish IPNS records via **delegated HTTP routing** (`delegatedRouting.putIPNS`). Browser-side DHT publishing is not used — it hangs in browser environments. The publish is fire-and-forget from `pushSnapshot()`'s perspective: the UI updates immediately while IPNS propagation continues in the background.

The IPNS sequence number is the **Y.Doc clockSum** — the sum of all state vector clocks across all subdocuments. This is deterministic: the same document state always produces the same seq, so multiple browsers publishing the same snapshot produce identical IPNS records (no race). A browser with more edits naturally gets a higher seq. On publish, the library guards against stale seq after page reload: `effectiveSeq = max(existingSeq + 1, clockSum)`, fetching the existing record from delegated routing to compare.

Publishes are serialized per key within a tab via a publish queue. If a publish is in-flight and a newer CID is queued, the stale CID is skipped.

### Resolution

All clients (writers **and** readers) resolve IPNS on `open()` to load the latest snapshot from the network. This is non-blocking — the doc opens immediately for WebRTC sync, and the resolved snapshot is applied via Yjs CRDT merge (safe regardless of local state). Writers need this for recovery after all tabs close.

Resolution tries **delegated HTTP first** (fast, reliable), falling back to **full Helia routing** (includes DHT) if delegated fails. Both paths have a 15s timeout.

### Snapshot notification channels

| Channel                  | Speed     | Persistence              | Use                                                         |
| ------------------------ | --------- | ------------------------ | ----------------------------------------------------------- |
| GossipSub announcements  | Immediate | Ephemeral                | Fast propagation to online pinners **and all peers**        |
| IPNS polling (30s)       | Delayed   | N/A                      | Fallback when no GossipSub peers are connected              |
| DHT (IPNS resolve)       | ~seconds  | Persistent, expires ~24h | Cold bootstrap, pinner re-resolution                        |

Writers publish a GossipSub announcement on topic
`/pokapali/app/{appId}/announce` immediately after each
`pushSnapshot()`. The announcement is a JSON message:

```ts
interface Announcement {
  ipnsName: string;  // hex-encoded IPNS name
  cid: string;       // CID of the snapshot block
  blockData?: string; // base64-encoded block (inline)
  fromPinner?: true;  // set by pinner re-announces
}
```

**Inline block distribution.** Bitswap does not work for
browser→relay block fetching (NAT/WebRTC prevents inbound
connections). Instead, snapshot blocks are embedded directly
in GossipSub announcements as base64-encoded `blockData`.
A 256KB size guard prevents oversized messages. This
eliminates the need for a separate block fetch path for
typical documents. Pinners validate inline blocks directly
from the announcement without a blockstore round-trip.

Writers re-announce every 15 seconds (and re-put the block
to the blockstore so late-joining pinners can fetch it).
All clients — both readers and writers — subscribe to
announcements, apply snapshots directly from the
announced CID, and then re-announce the CID (with inline
block) and store the block in their local blockstore. This
makes every connected peer a gossip amplifier and block
provider, improving availability in sparse networks.
Readers track `lastAnnouncedCid` per session to avoid
re-announce amplification loops.

As a fallback, all clients poll IPNS via `watchIPNS`
(30s interval) to catch updates when no GossipSub peers
are connected.

Pinners re-publish DHT IPNS records every ~4 hours (via `republishRecord`, which re-puts the existing signed record without needing the private key) to prevent expiry. This keeps records alive when writers are offline. Republishing is sequential with 5s delays between names to avoid overwhelming the relay's DHT connections.

---

## Permission-less Pinning Servers

Pinners are structurally zero-knowledge. They never possess `readKey` and cannot decrypt document content or `_meta`. A pinner is configured with one or more `appId` values and automatically discovers and pins all documents created by any user of those apps — no per-document setup required.

### Discovery

When a peer pushes a snapshot, the library publishes the
block to the Helia blockstore, publishes an IPNS record via
delegated HTTP routing, then announces on the GossipSub
topic with inline block data (see "Snapshot notification
channels" above). Pinners subscribed to that topic discover
documents automatically — this is the primary discovery
path. Relay nodes subscribe to announcement topics for
their configured `pinAppIds` and forward messages between
browsers and pinners via the GossipSub mesh.

On receiving an announcement, pinners validate inline block
data directly from the message — no blockstore round-trip
needed. They store validated blocks to the persistent
`FsBlockstore`. If no inline block is present, they fall
back to `blockstore.get`. As a secondary fallback, pinners
periodically re-resolve all known IPNS names (every 5
minutes) to catch updates if announcements are missed.

### Jobs

Once a pinner discovers an IPNS name, its ongoing jobs are:

1. Validate inline block data from announcements (or
   resolve IPNS as fallback) → verify snapshot signature
   is structurally valid (well-formed Ed25519) → pin the
   block to `FsBlockstore`
2. **Keep all snapshots from the last 24 hours** —
   time-windowed, not count-based
3. Prune snapshots older than 24 hours (always keep the
   tip regardless of age). `history.prune()` returns CIDs
   of pruned snapshots for blockstore cleanup.
4. **Re-publish DHT IPNS records every ~4 hours** — uses
   `republishRecord` (no private key needed), sequential
   with 5s per-name delays to limit DHT load on the
   relay; checks `stopped` flag between names to allow
   cancellation during shutdown
5. **Re-announce known CIDs** with inline blocks so that
   late-joining peers and other pinners can fetch blocks
   without Bitswap. Currently runs on a flat 30s cycle
   over all known documents. At scale, this is replaced
   by the continuous scheduling model (see below).

### Pinner acknowledgment

When a pinner successfully ingests a snapshot, it publishes
an ack on the same announce topic:

```ts
interface AnnouncementAck {
  ipnsName: string;
  cid: string;
  ack: true;
  peerId: string;
  guaranteeUntil?: number; // re-announce end (ms epoch)
  retainUntil?: number;    // block storage end (ms epoch)
}
```

Writers track `ackCount` and `ackedBy` (deduped by peerId)
to display "Saved to N relay(s)" in the UI. Pinners track
`lastAckedCid` per IPNS name to avoid redundant re-fetches
on duplicate announcements — they still re-ack without
re-fetching so the writer sees confirmation.

### Two-phase guarantee protocol (designed)

Pinners provide a two-phase commitment for each document:

1. **Active re-announcing (7 days).** The pinner continues
   re-announcing the doc's CID on GossipSub with inline
   blocks, making it discoverable to new peers and other
   pinners. Re-announce frequency follows the decay
   formula (see below), capped at once per 24 hours.
   `guaranteeUntil = lastSeenAt + 7 days`.

2. **Block retention (14 days total).** After re-announcing
   stops, blocks stay in the `FsBlockstore` and IPNS
   records continue being republished (every 4 hours).
   Content is fetchable via IPNS resolve + block get, but
   not actively advertised on GossipSub.
   `retainUntil = lastSeenAt + 14 days`.

Both timestamps are absolute (ms since epoch), idempotent
on re-announce. Any activity (writer or reader
announcement) refreshes `lastSeenAt` and extends both
windows. A user who closes their laptop for 10 days comes
back to a recoverable doc — still within the 14-day
retention window even though GossipSub re-announces
stopped at day 7.

After 14 days of total inactivity, blocks are pruned from
the blockstore and the doc is removed from pinner state.
The doc is rediscovered automatically if a writer or
reader re-announces it.

**Monotonic guarantees.** For the same CID, guarantee
timestamps are monotonically non-decreasing (the pinner
tracks `guaranteedUntil` per IPNS name and uses
`Math.max`). When the writer publishes a new CID, the
guarantee resets — the pinner must prove it has the new
block before committing.

**Self-tuning capacity.** The pinner measures re-announce
cost via an exponential moving average (EMA) of per-doc
milliseconds. Capacity is derived from a target cycle
time: `capacity = 25,000ms / perDocEma`. Under heavy
load, the pinner can reduce the guarantee proportionally,
but the floor is 24 hours (at least one re-announce per
day while in the active window).

### Continuous scheduling (designed)

At scale, the flat re-announce loop (O(N) every 30s)
becomes the bottleneck. The replacement is a continuous
priority model:

- Re-announce interval scales with inactivity:
  `interval = BASE * 2^(age/HALF_LIFE) * loadFactor`
- A **min-heap priority queue** ordered by next-deadline
  (`lastAnnounced + interval`) replaces the flat loop
- Five constants with physical meaning:
  - `BASE` (30s): interval for a just-edited document
  - `HALF_LIFE` (12h): time for interval to double
  - `MAX_INTERVAL` (24h): re-announce frequency ceiling
  - `GUARANTEE_DURATION` (7d): active re-announce window
  - `RETENTION_DURATION` (14d): block storage window

Interval progression at idle (no load factor):
```
t=0:      30s       t=3d:     32min
t=12h:    60s       t=4d:     ~2h
t=1d:     2min      t=5d:     ~8.5h
t=2d:     8min      t=5.5d+:  24h (capped)
```

The model is self-rate-limiting: at high load, intervals
stretch, fewer docs due per cycle. GossipSub's
`seenCache` (2-minute TTL) provides a natural floor on
re-announce frequency.

**Reader activity as demand signal.** When a non-pinner
peer (reader or writer) re-announces a CID, the pinner
updates `lastSeenAt` for that document *before* the dedup
early return in `onAnnouncement`. This refreshes the
document's priority and extends both guarantee windows
without triggering a re-fetch.

Pinner re-announces are *supply signals*, not demand
signals — they indicate the pinner is doing its job, not
that anyone is reading the doc. The `fromPinner` field on
announcements lets pinners distinguish: when
`fromPinner: true`, the receiving pinner skips the
`lastSeenAt` refresh. Without this, multiple pinners would
keep each other alive indefinitely (pinner A re-announces
→ refreshes B's window → B re-announces → refreshes A's
window → infinite loop, docs never expire).

**State pruning.** Primary rule: prune when
`lastSeenAt + 14 days < now`. Capacity backstop: if
tracking exceeds `maxActiveDocs * 10`, prune
oldest-by-`lastSeenAt` first even if under 14 days.
Pruning removes `knownNames`, `tips`, `nameToAppId`,
`lastSeenAt`, and blocks from blockstore.

### Multi-pinner redundancy

Adding more pinners (with or without sharding) improves
guarantees in three ways:

1. **Redundancy.** Each pinner independently stores blocks
   and re-announces. The client sees "Saved to N pinners."
   If one pinner crashes, others still serve the doc.
   P(doc lost) = product of independent failure
   probabilities — with 3 pinners at 99% uptime each,
   effective availability is 99.9999%.

2. **Load distribution.** With pinner sharding
   (`--shard N/M`), each pinner handles fewer docs,
   keeping utilization low and loadFactor at 1.0. This
   ensures full 7-day guarantees are maintained even at
   high doc counts where a single pinner would be
   overloaded and forced to reduce guarantees.

3. **Independent clocks.** Each pinner's guarantee is
   based on its own `lastSeenAt`. If pinner A misses an
   announcement due to a network partition but pinner B
   receives it, B's guarantee window is refreshed
   independently. The client tracks per-pinner guarantees
   and shows the best one.

Individual guarantee duration is unchanged — each
pinner's 7d/14d windows are based on its own constants
and utilization, not the relay count. More pinners give
more redundancy, not longer individual guarantees.

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

Bootstrap peers default to the standard libp2p bootstrap list, also Protocol Labs-operated. Once connected, peer discovery is organic through the DHT — bootstrap nodes are only needed for initial network entry. Browser-side Helia bootstrap has a 30s timeout (`Promise.race` against `createHelia()`) to prevent indefinite hangs if all bootstrap peers are unreachable.

### Server-side: `@pokapali/node`

The `@pokapali/node` package provides `startRelay()`, `createPinner()`, and an HTTP server for health monitoring. A relay is generic network infrastructure (any relay serves any app); a pinner is configured with specific `appId` values. Both typically run in the same Node.js process, sharing a single Helia instance.

Pinner state (`knownNames`, `tips`, `nameToAppId`) is
persisted to `state.json` in the storage directory. Writes
use a dirty-flag + 5-second debounced flush + 60-second
safety-net interval to avoid excessive disk I/O during
bursts of announcements. On startup, `tips` and
`nameToAppId` are restored from `state.json` so the pinner
can immediately re-announce inline blocks for all known
documents without waiting for new announcements.

Pinner shutdown is graceful: `stop()` sets a `stopped` flag (checked by the IPNS republish loop between names), cancels the initial republish timer, clears periodic intervals, flushes in-flight fetch operations via `flush()` (`Promise.allSettled` on all tracked promises), and persists state to disk.

The relay runs Helia with full libp2p defaults, client-mode
DHT, GossipSub (tuned D/Dlo/Dhi for small networks),
autoTLS for WSS, and persistent key + datastore. It
subscribes to peer discovery, signaling, and announcement
topics, and provides a network-wide CID on the DHT for
browser discovery. The relay blockstore is `FsBlockstore`
(persistent across restarts) at `storagePath/blockstore`.
Note: `FsBlockstore` v3 `get()` returns an
`AsyncGenerator`, not a `Uint8Array` — the relay wraps
this with a safe type-check adapter.

**Relay-to-relay GossipSub topology.** Currently relays
use `floodPublish: true`, which broadcasts every message
to all connected peers. This works at small scale but
causes a broadcast storm at 100+ nodes. The designed
replacement is **dynamic direct peering via DHT
discovery**:

1. Relays discover each other via DHT
   `findProviders(networkCID)` (already implemented)
2. After successful dial, add the peer to
   `pubsub.direct` (a `Set<string>` on the GossipSub
   instance, checked at runtime in `selectPeersToPublish`,
   `selectPeersToForward`, `acceptFrom`,
   `directConnect` heartbeat, and mesh exclusion)
3. Direct peers always receive published messages
   regardless of mesh state — guaranteed delivery
   without broadcast
4. Disable `floodPublish` on relays (browsers keep it —
   they have only 2-4 relay peers, negligible bandwidth)

This is ~7 lines of code in `relay.ts`
(`findAndDialProviders`). No hardcoded addresses — relay
discovery is entirely via DHT. The `directConnect()`
heartbeat reconnects dropped direct peers using
`this.direct` (the Set), not `this.opts.directPeers`
(the config array), so dynamically added peers get
heartbeat reconnection too. Expected 5× bandwidth
reduction at 25+ peers.

The HTTP server exposes:
- `GET /healthz` — returns `200 OK` when the node is running (used for deployment health checks; the relay takes ~25s to start due to autoTLS cert provisioning)
- `GET /status` — returns JSON diagnostics: peer count, connection details, GossipSub mesh/topic stats, pinned document count, and pinner state

### Node capability broadcasting

Nodes advertise their roles via a dedicated GossipSub
topic `pokapali._node-caps._p2p._pubsub`. Every 30
seconds, a node publishes a JSON capability message:

```ts
interface NodeCapabilities {
  version: 1;
  peerId: string;
  roles: string[];  // e.g. ["relay", "pinner"]
}
```

Roles are configured at startup — a relay-only node
advertises `["relay"]`, a pinner-only node `["pinner"]`,
and a combined node `["relay", "pinner"]`. The roles
come from the node's config, not inferred from behavior.

On the browser side, `@pokapali/core` maintains a
**node registry** (per-Helia singleton) that subscribes
to the caps topic, upserts known nodes on each message,
prunes stale entries (no message in 90 seconds), and
cross-references with `libp2p.getConnections()` for live
connection status. The registry also merges in data from
existing signals: `relayPeerIds` (DHT discovery) and
`ackedBy` (GossipSub acks). A node that acked a snapshot
gets the `"pinner"` role even before its caps message
arrives.

`DiagnosticsInfo` exposes this as `nodes: NodeInfo[]`
(replacing the previous `relays: RelayDiagnostic[]`):

```ts
interface NodeInfo {
  peerId: string;
  short: string;
  connected: boolean;
  roles: string[];
  ackedCurrentCid: boolean;
  lastSeenAt: number;
}
```

The distinction between **advertisement** ("I can do
this") and **proof** ("I did do this") is deliberate:
caps messages declare capability, acks confirm action.
Both are useful for the UI — "Connected to N node(s),
pinned by M."

Bandwidth at steady state is low. Suitable for a VPS or homelab behind standard NAT.

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

### Threat 7: Relay node misbehaves

A relay node forwards GossipSub signaling messages between browsers. It can observe which IPNS names are active as WebRTC rooms (already public). It can block connections (DoS, mitigated by multiple relays). It cannot read content. **Tolerable worst case.**

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

Relay nodes (`@pokapali/node`) subscribe to the signaling
topic, the peer discovery topic, and announcement topics
for configured `pinAppIds`. They forward messages between
browsers via the GossipSub mesh. Relays use autoTLS
(`@ipshipyard/libp2p-auto-tls`) for automatic WSS
certificate provisioning, and run client-mode DHT to
provide records without serving DHT queries.

Browsers discover relays via DHT (looking up a
network-wide CID derived from `sha256("pokapali-network")`,
not per-app or per-document) and cached relay addresses in
`localStorage` (24h TTL, 48h max age). **No relay addresses
are hardcoded** — all relay discovery is via DHT or peer
exchange. Relay caching logic is in `relay-cache.ts`
(extracted from `peer-discovery.ts` for testability). On
startup, browsers try cached relays first (fast direct
dial) then run DHT discovery in parallel.
Connected peers also share relay addresses via the
awareness channel, so a browser that discovers a relay
propagates it to all collaborators. This makes relays
generic network infrastructure — any relay serves any app.

Two browsers sharing the same document URL can collaborate
with zero self-hosted infrastructure — only public
IPFS/libp2p bootstrap nodes are needed for initial peer
discovery.

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
| `helia`                                       | IPFS in browser and relay/pinner; delivers snapshot updates via delegated routing   |
| `@ipld/dag-cbor`                              | IPFS block encoding for snapshots (IPLD-native CID handling)                       |
| `@helia/ipns`                                 | IPNS publish (delegated HTTP) / resolve (delegated + DHT fallback)                 |
| `ipns`                                        | IPNS record creation and validation                                                |
| `@chainsafe/libp2p-gossipsub`                 | GossipSub pubsub — signaling, peer discovery, snapshot announcements, and node capability broadcasting |
| `@libp2p/crypto/keys`                         | IPNS keypair derivation from seed                                                  |
| `@libp2p/pubsub-peer-discovery`               | Browser peer discovery via GossipSub                                               |
| `@libp2p/kad-dht`                             | DHT for relay (client-mode) — record providing and IPNS republish                  |
| `@ipshipyard/libp2p-auto-tls`                 | Automatic TLS certificates for relay WSS                                           |
| `datastore-level`                             | Persistent LevelDB datastore for relay                                             |
| `@pokapali/log`                                | Zero-dependency structured logging (`createLogger(module)`) — leaf package used by all other packages |
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

### CLI and MCP agent interface (designed)

A programmatic interface for LLM agents to read and write
pokapali documents without a browser. Two delivery formats:

1. **CLI commands** (`pokapali read <url>`,
   `pokapali write <url>`) — stateless, one Helia boot per
   invocation (~5-15s startup). Good for scripting and
   simple agent workflows.
2. **MCP server** — long-running process with persistent
   Helia node. Amortizes boot cost across many operations.
   Exposes `read_document`, `write_document`,
   `list_documents` as MCP tools.

Both use `@pokapali/core` individual module imports (not
the main export, which crashes in Node.js due to y-webrtc
/ simple-peer). Content model: Tiptap stores rich text as
`XmlFragment` in subdoc `"content"` — the CLI converts
between plain text and `XmlElement` paragraphs for
round-tripping.

The interface is read/write only (no real-time sync). A
write operation creates a snapshot and publishes to IPNS;
a read operation resolves IPNS and decrypts the latest
snapshot. This is sufficient for agent use cases (review
a document, add comments, update content).

---

P2P systems are inherently difficult to integration-test — there's no central server to assert against, and behavior depends on the combination of peers, capability levels, network timing, and CRDT merge order. Plan for this early; retrofitting a test harness onto a P2P library is painful.

The library should include a test harness that spins up multiple in-process Yjs/Helia nodes with different capability URLs — e.g., one admin, one content+comments writer, one comments-only writer, one read-only peer — and exercises the core invariants: namespace isolation (a comments-only peer's local content mutations don't propagate), snapshot round-tripping (push a snapshot, cold-bootstrap a new peer from it, verify state), CRDT merge convergence (two writers edit concurrently, verify all peers converge), read-only delivery (push a snapshot, verify read-only peer receives it via GossipSub announcement), and revocation (rotate keys, verify old-capability peers are locked out of new rooms). The snapshot fetch coalescing logic (concurrent fetches, first-success-wins, CID list pruning) deserves its own unit tests with simulated fetch latencies.
