# Architecture Reference

A serverless, encrypted, peer-to-peer collaborative
document sync library using Yjs channels, WebRTC,
IndexedDB, and Helia/IPFS for offline persistence.
Designed to be dropped into any Yjs-aware editor (TipTap,
ProseMirror, CodeMirror, etc.) with minimal integration
surface.

Channel write enforcement is structural: each channel is
a separate Yjs subdocument synced over its own y-webrtc
room, and peers only join rooms for channels they can
write to. Read-only access to all channels is delivered
via GossipSub-announced and IPNS-polled snapshot updates.

**Topic guides:**

| Topic                 | File                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| State management      | [architecture/state-management.md](architecture/state-management.md) |
| Channels & sync       | [architecture/channels.md](architecture/channels.md)                 |
| Persistence & IPNS    | [architecture/persistence.md](architecture/persistence.md)           |
| Infrastructure        | [architecture/infrastructure.md](architecture/infrastructure.md)     |
| Security              | [architecture/security.md](architecture/security.md)                 |
| Signaling & discovery | [architecture/signaling.md](architecture/signaling.md)               |

See also: [principles.md](principles.md),
[deps.md](deps.md), [guide.md](guide.md).

---

## Core Principles

- **No privileged server** — peers sync directly via
  WebRTC; pinning servers are permission-less and
  fungible
- **Encryption** is symmetric, derived from a shared
  secret in the URL fragment, invisible to any relay
  or pinner
- **Document identity** is an IPNS name (public key
  hash) in the URL path, stable across snapshot updates
- **Capability levels** are encoded in the URL fragment
  as a set of channel access keys over n channels
- **`canPushSnapshots` is an independent trust flag** —
  not implied by any channel set, granted explicitly
- **Pinning servers** store and serve encrypted blobs
  they can't read; anyone can run one
- **Pinners are structurally zero-knowledge** — they
  validate block structure and signatures but cannot
  verify authorization (which keys are _allowed_),
  because that requires decrypting `_meta` with
  `readKey`
- **App namespacing** is a public string baked into key
  derivation — not a secret, not authentication
- **Recoverability is structural** — every IPFS snapshot
  is a complete, self-sufficient document state
- **State is derived, not mutated** — all document state
  flows from an append-only fact log through pure
  reducers (see [state management](architecture/state-management.md))
- **Channel enforcement is structural** — each channel
  is a separate Yjs subdocument with its own y-webrtc
  room; peers only join rooms for channels they can
  write to, so unauthorized writes are impossible at
  the transport level
- **Read access is all-or-nothing and snapshot-driven**
  — `readKey` decrypts all channels; peers receive
  read-only channel updates via GossipSub-announced
  and IPNS-polled snapshot fetches, not WebRTC, so
  read latency equals snapshot interval
- **The library has no opinion on content** — it
  enforces which channel access key gates which
  channel; what lives in those channels is entirely
  the application's business
- **The library has no opinion on snapshot timing** —
  it exposes `publish()` and emits `"publish-needed"`;
  when to call it is application policy

---

## Recoverability Guarantees

These guarantees hold regardless of which peers are
online, which capability levels are in play, or how many
snapshots exist in the chain.

**Each snapshot is a full `Y.encodeStateAsUpdate` per
channel** — a complete Yjs state for every channel, not
a delta. Any single snapshot CID is independently
sufficient to reconstruct the entire document (all
channels) at that point in time. The `prev` chain is for
version history traversal only — losing any node (or all
but one) does not affect recoverability.

**The `prev` chain is append-only and
content-addressed.** CIDs are immutable hashes of their
content. Nothing in history can be altered or deleted
retroactively.

**Yjs CRDT merges are always safe.** Divergent snapshots
from peers with different views converge unconditionally
when those peers sync over WebRTC.

**Pinners keep 24 hours of snapshot history.** This gives
admins a rollback backstop — if a malicious snapshot is
published, the admin can use `rotationKey` to manually
point IPNS at a known-good CID from within the pinned
window, or migrate the document identity entirely if the
pointer has been frozen.

**The one real risk is resource exhaustion, not data
loss.** Any peer with `ipnsKey` could flood the network
with snapshots. This is an availability/cost concern, not
a data integrity concern. Pinners rate-limit snapshot
ingestion per IPNS name. The social mitigation is:
`canPushSnapshots` is a meaningful trust boundary — don't
grant it to strangers.

---

## Library API

The library owns sync, persistence, and crypto. The
integrating app owns the editor binding, UI, and snapshot
timing policy.

```ts
import { pokapali } from "@pokapali/core";

// Initialize once. appId is a public string — not a
// secret. channels: the set of channels the library
// manages. Each channel becomes its own Y.Doc.
const app = pokapali({
  appId: "github.com/yourname/your-editor",
  channels: ["content", "comments"],
});

// Create a new document
const doc = await app.create();
doc.channel("content"); // Y.Doc for "content"
doc.channel("comments"); // Y.Doc for "comments"
doc.provider; // for awareness / cursor presence
doc.capability; // { namespaces, canPushSnapshots,
//   isAdmin }
doc.urls.admin; // keep private — derives everything
doc.urls.write; // read + write + canPushSnapshots
doc.urls.read; // read only

// Reactive state via Feed (useSyncExternalStore-
// compatible)
doc.status; // Feed<DocStatus>
doc.saveState; // Feed<SaveState>
doc.tip; // Feed<VersionInfo | null>
doc.loading; // Feed<LoadingState>
doc.versions; // Feed<VersionHistory>

// Synchronous getters (current snapshot)
doc.status; // "connecting" | "synced" | ...
doc.saveState; // "saved" | "dirty" | ...

// Generate a custom capability URL
doc.invite({
  namespaces: ["comments"],
  canPushSnapshots: true,
});

// Open an existing document
const doc2 = await app.open(url);

// Snapshot management
await doc.publish();
doc.on("publish-needed", () => {
  doc.publish();
});

// Full editor integration
const editor = new Editor({
  extensions: [
    Collaboration.configure({
      document: doc.channel("content"),
    }),
    CollaborationCursor.configure({
      provider: doc.provider,
    }),
  ],
});
```

Read-only peers should not be connected to the content
WebRTC room — they receive content updates via
GossipSub-announced and IPNS-polled snapshot fetches.
The application should reflect this in the editor
configuration:

```ts
const isReadOnly = !doc.capability.namespaces.has("content");
const editor = new Editor({
  editable: !isReadOnly,
  extensions: [
    Collaboration.configure({
      document: doc.channel("content"),
    }),
    CollaborationCursor.configure({
      provider: doc.provider,
    }),
  ],
});
```

### Snapshot timing is the app's responsibility

The library deliberately does not call `publish()`
automatically on any trigger, including disconnect. The
app should:

- Call `publish()` on a periodic timer while the
  document is open
- Attempt `publish()` in a `beforeunload` /
  `visibilitychange` handler (best-effort — see
  caveats below)
- Optionally show a save indicator tied to
  `doc.saveState`
- Listen for `"publish-needed"` as a hint that a
  publish would be timely

### Snapshot frequency affects read-only peer latency

Peers who can only read a channel (not write to it)
receive updates for that channel via GossipSub-announced
and IPNS-polled snapshot fetches — not via WebRTC. This
means **snapshot frequency directly determines how stale
read-only content appears to limited-capability peers.**

| Scenario                                | Interval | Rationale                           |
| --------------------------------------- | -------- | ----------------------------------- |
| Active editing, read-only peers present | 30–60s   | Keeps read-only content fresh       |
| Active editing, all peers are writers   | 2–5 min  | Durability and version history only |
| Idle (no edits since last snapshot)     | No push  | Avoid unnecessary pinner load       |

**`beforeunload` caveats:** Browsers do not honor async
work in `beforeunload` handlers. On mobile,
`beforeunload` may not fire at all. The realistic
durability mechanism is periodic saves; `beforeunload`
is a best-effort supplement, not a guarantee.

```ts
window.addEventListener("beforeunload", (e) => {
  if (doc.saveState === "dirty") {
    e.preventDefault();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && doc.saveState === "dirty") {
    doc.publish(); // fire-and-forget
  }
});
```

---

## Core Module Structure

The `@pokapali/core` package is organized into these
module groups:

### State management (fact-stream architecture)

| Module           | Purpose                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `facts.ts`       | Fact union type (27 variants), DocState/ChainState interfaces, initial state constants         |
| `reducers.ts`    | Pure reducers: chain, gossip, connectivity, content, announce. Derives status and saveState    |
| `sources.ts`     | `createAsyncQueue`, `merge`, `scan`, `createFeed`, fact source generators                      |
| `interpreter.ts` | Effect dispatcher: fetches blocks, applies snapshots, schedules wake-ups. The only impure code |

See [state management](architecture/state-management.md)
for how these modules compose.

### Document lifecycle

| Module               | Purpose                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `index.ts`           | `pokapali()` factory, `PokapaliApp` (.create, .open)                                       |
| `create-doc.ts`      | `createDoc()` — wires interpreter, effect handlers, GossipSub bridge, Feeds. Returns `Doc` |
| `doc-diagnostics.ts` | `diagnostics()` — node info, network state                                                 |
| `doc-rotate.ts`      | `rotate()` — identity migration                                                            |
| `auto-save.ts`       | `createAutoSaver` — 5s debounce, visibility/beforeunload hooks                             |

### Snapshot & persistence

| Module              | Purpose                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `snapshot-codec.ts` | Snapshot encode/decode/decrypt, chain tip state (prev/seq), version loading    |
| `block-resolver.ts` | Unified block resolution: memory → IDB → HTTP. Single read/write interface     |
| `fetch-block.ts`    | Low-level block fetch with retry/backoff (blockstore → HTTP). Used by resolver |

### Networking & discovery

| Module                | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `announce.ts`         | GossipSub announcement + ack + guarantee-query/response protocol |
| `topology-graph.ts`   | `topologyGraph()`, `nodeKind()` — network visualization data     |
| `topology-sharing.ts` | Awareness relay topology + knownNodes caps rebroadcast           |
| `node-registry.ts`    | Per-Helia singleton, KnownNode, v2 caps                          |
| `peer-discovery.ts`   | DHT relay discovery, reconnect, 30s FIND_TIMEOUT                 |
| `relay-cache.ts`      | localStorage relay address cache (24h TTL)                       |
| `helia.ts`            | Shared Helia singleton with ref counting                         |
| `ipns-helpers.ts`     | IPNS publish/resolve helpers                                     |

### Utilities

| Module             | Purpose                             |
| ------------------ | ----------------------------------- |
| `url-utils.ts`     | URL parsing, capability extraction  |
| `relay-sharing.ts` | Relay address sharing via awareness |
| `forwarding.ts`    | Rotation forwarding records         |

---

## URL Structure

```
myapp.com/doc/<ipns-name>#<version-byte><key-material>
```

| Part              | Visibility         | Purpose                                                                                                                                                                       |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<ipns-name>`     | Public (path)      | Stable document ID — same across all capability levels. Used as prefix for y-webrtc room names, IndexedDB DB names, pubsub topic, DHT key                                     |
| `#<version-byte>` | Private (fragment) | Format version — enables future key derivation scheme changes                                                                                                                 |
| `<key-material>`  | Private (fragment) | Always contains `readKey` and `awarenessRoomPassword`. Optionally contains `ipnsKey`, `rotationKey`, and channel access keys. The set of included keys defines the capability |

Capability is implicit in which keys are present — the
library detects this on `open()` by inspecting which
channel access keys are included in the fragment.

---

## Key Derivation

All keys derived from `adminSecret` via HKDF. The `info`
parameter encodes both the `appId` and the derivation
purpose, following standard HKDF convention (RFC 5869):
`info` is the context/purpose differentiator, `salt` is
omitted (empty).

```ts
async function deriveDocKeys(
  adminSecret: string,
  appId: string = "",
  channels: string[],
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

  const readKey = await deriveAES("read");
  const ipnsKeyBytes = await deriveBits("ipns");
  const rotationKey = await deriveBits("rotation");
  const awarenessRoomPassword = await deriveBits("awareness-room");

  const channelKeys = Object.fromEntries(
    await Promise.all(
      channels.map(async (ch) => [ch, await deriveBits(`ns:${ch}`)]),
    ),
  );

  return {
    readKey,
    ipnsKeyBytes,
    rotationKey,
    channelKeys,
    awarenessRoomPassword,
  };
}
```

`appId` is a public string — it identifies which
application's key space this document belongs to. It is
baked into key derivation to prevent cross-app key
collisions, and it defines the pubsub topic
(`/app/${appId}/announce`) that pinners subscribe to for
automatic document discovery. It is not a secret.

### Fragment key material

The fragment always contains `readKey` and
`awarenessRoomPassword` (both required at every
capability level). Beyond that, it contains whichever
of `ipnsKey`, `rotationKey`, and channel access keys
that the capability grants — serialized as a labeled,
length-prefixed list.

---

## Bundle Size

Helia + libp2p is not a lightweight dependency. Expect
500KB+ minified/gzipped for the full IPFS stack.
y-webrtc itself is lightweight (~15KB); the IPFS stack
is the main contributor.

Possible mitigations:

- **Lazy-load Helia** — for write-capable peers, the
  editor is functional with just Yjs + y-webrtc +
  y-indexeddb (~30KB). Load Helia asynchronously for
  snapshot push/pull.
- **Pinning-only mode** — skip the full IPFS stack.
  Use a lightweight HTTP API to push snapshots to a
  pinning server directly.
- **Tree-shaking** — Helia is modular. Only import the
  routers, block codecs, and transports actually used.

---

## Future Extensions

### Per-user identity within channels

The current design treats all peers with the same
channel access key as equal — anyone in the `comments`
room can edit or delete anyone else's comments. A
natural next step is per-user identity:

1. Each user generates a keypair client-side (Ed25519)
2. The user's public key is registered in `_meta`
   under the channel
3. Entries include the author's public key and a
   signature
4. The application layer enforces "you can only edit
   entries you authored"

This is cooperative enforcement at the intra-channel
level, but the trust surface is much smaller than the
original single-Y.Doc design. The room password still
provides the structural access boundary.

**Application guidance:** within annotation channels,
store entries as `Y.Map` instances with room for
metadata fields (author public key, signature,
timestamps) rather than bare strings in a `Y.Array`.

### CLI and MCP agent interface (designed)

A programmatic interface for LLM agents to read and
write pokapali documents without a browser. Two
delivery formats:

1. **CLI commands** (`pokapali read <url>`,
   `pokapali write <url>`) — stateless, one Helia
   boot per invocation (~5-15s startup)
2. **MCP server** — long-running process with
   persistent Helia node. Exposes `read_document`,
   `write_document`, `list_documents` as MCP tools

Both use `@pokapali/core` individual module imports
(not the main export, which crashes in Node.js due to
y-webrtc / simple-peer). Content model: Tiptap stores
rich text as `XmlFragment` in subdoc `"content"` — the
CLI converts between plain text and `XmlElement`
paragraphs.
