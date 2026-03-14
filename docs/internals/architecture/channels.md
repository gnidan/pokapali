# Channels & Sync

## Channel Enforcement via Room Isolation

Each channel is a separate `Y.Doc` with its own
y-webrtc room. Write enforcement is structural: a peer
only joins the y-webrtc room for channels it has access
keys for. Read access to all channels is delivered via
IPNS-resolved and GossipSub-announced snapshot fetches.

### Sync architecture

For each channel in the peer's capability set
(`doc.capability.channels`), the library creates a
`WebrtcProvider` connecting to a room named
`${ipnsName}:${channel}`. This gives the peer
real-time bidirectional CRDT sync for that channel —
standard y-webrtc, no custom protocol.

`SyncManager` listens for y-webrtc `"status"` events
on each provider and exposes `onStatusChange(cb)` so
that `@pokapali/core` can re-compute `doc.status`
whenever the underlying WebRTC connection state changes.
`aggregateStatus` uses **any-connected** semantics: if
at least one provider is connected, status is
`"connected"`. Partial writers (with access to a subset
of channels) may have some rooms with peers and others
empty — the empty rooms don't indicate a broken
connection.

### Document status model

`doc.status` reflects **connectivity** as a composite
of three transport layers:

```ts
type DocStatus =
  | "connecting" // bootstrapping, no transport ready
  | "synced" // WebRTC connected to ≥1 channel room
  | "receiving" // no WebRTC peers, GossipSub active
  | "offline"; // no transports active
```

The derivation considers WebRTC channel providers,
awareness room connectivity, and GossipSub liveness
(a 60-second recency window on received messages,
with exact wake-up scheduling via the interpreter):

1. If any channel WebRTC provider is connected →
   `"synced"`
2. If channel providers are connecting →
   `"connecting"`
3. If the awareness room is connected or a GossipSub
   message was received within 60 seconds →
   `"receiving"`
4. If subscribed to GossipSub but no recent messages →
   `"connecting"`
5. Otherwise → `"offline"`

The `"receiving"` state is the typical reader state:
readers have no channel providers (empty capability
set), but they actively receive snapshot updates via
GossipSub and cursor presence via the awareness room.

**Save state** is tracked separately from connectivity:

```ts
type SaveState =
  | "saved" // snapshot pushed and acked
  | "dirty" // local changes not yet pushed
  | "saving" // push in progress
  | "unpublished"; // no snapshot pushed yet (new doc)
```

Exposed as `doc.saveState`. This separation lets the
UI show a connection indicator and a save indicator
independently.

### Snapshot notification channels

All clients — writers **and** readers — resolve IPNS
on `open()` to load the latest snapshot from the
network (non-blocking; Yjs CRDT merge is safe). Writers
need this for recovery after all tabs close. Both also
watch for live updates via two transport paths:

1. **GossipSub announcements** (primary, instant):
   writers publish `{ "ipnsName", "cid" }` on
   `/pokapali/app/{appId}/announce` after each
   `publish()`. All clients subscribe and apply
   snapshots directly from the announced CID.
2. **IPNS polling** (fallback, 30s interval): catches
   updates when no GossipSub peers are connected.

For channels the peer can only read (not in its
capability set), the library does **not** connect to
the WebRTC room. The peer receives all channel content
from snapshot updates (announced or polled).

After successfully applying a remote snapshot, **all
clients** (not just writers) store the fetched block in
their Helia blockstore (`blockstore.put`) and
re-announce the CID on the GossipSub announce topic.
This makes every connected peer — including read-only
peers — a block provider via bitswap and a propagation
amplifier via GossipSub. The block is content-addressed
(can't be forged) and encrypted (no plaintext leak), so
this is safe regardless of capability level. Block
availability is session-scoped (Helia uses
`MemoryBlockstore` by default; blocks do not persist
across tab close).

### Why this is structural

A peer without the access key for a channel never joins
that channel's WebRTC room. There is no code path —
honest or malicious — through which they can inject
mutations into the real-time sync for that channel.
y-webrtc is unmodified; enforcement comes from room
membership, not from intercepting messages.

A malicious client could attempt to connect to a room
it shouldn't have access to. y-webrtc rooms are
identified by name, so a peer could construct the room
name and join the GossipSub signaling topic. However,
the room uses y-webrtc's `password` option, set to the
hex-encoded channel access key bytes. The password is
used to derive a `CryptoKey` that encrypts all
signaling messages (SDP offers, answers, ICE
candidates). A peer without the correct access key
cannot decrypt incoming signaling messages, and its own
incorrectly-encrypted messages are rejected. Since the
WebRTC SDP exchange cannot complete, no peer connection
is established.

> **Note:** WebRTC data channel messages rely on
> WebRTC's built-in DTLS transport encryption, not
> application-layer encryption by y-webrtc. The access
> control boundary is at connection establishment, not
> at the message level.

### Read-only peers

A peer with only `readKey` (no channel access keys)
joins no content rooms — only the awareness room. It
receives all channel content from IPFS snapshots,
updated via GossipSub announcements (instant) and IPNS
polling (30s fallback) whenever a trusted peer pushes.

Read-only peers participate in gossip propagation:
after applying a snapshot, they store the block in
their Helia blockstore and re-announce the CID on
GossipSub. Writers additionally re-announce on a
periodic 15s timer; readers re-announce only once per
received snapshot.

Read-only content is not real-time — it updates at
snapshot frequency.

### Cross-channel references

Annotation channels (comments, suggestions, tracked
changes) reference positions in the content channel
using Yjs `Y.RelativePosition`. Creating a
RelativePosition reads from the content subdoc
(available to all peers) and stores it in the
annotation channel (writable by the annotator). This
requires no content write access — it's a read from
one channel and a write to another.

### `_meta` as a channel

`_meta` is itself a channel with its own y-webrtc
room. The room password is derived from the primary
channel's access key, so only peers who can write to
the primary channel can join the `_meta` room. It holds
access allowlists and configuration. The library
manages `_meta` internally; the application never
receives a writable reference to it.

---

## `_meta` Structure and CRDT Merge Semantics

### Structure

```ts
// _meta is its own Y.Doc, managed internally
const meta = doc.metaDoc; // not exposed to app

// Access allowlists: one Y.Array per channel
meta.getMap("authorized").get("content");
// Y.Array<Uint8Array>

// Snapshot push allowlist
meta.getArray("canPushSnapshots");
// Y.Array<Uint8Array> — ipnsKey public keys
```

### Merge behavior

`_meta` is subject to Yjs CRDT merge rules. In
practice this is a non-issue: admin operations
(adding/removing keys, forwarding to a new document)
should be coordinated out-of-band between admins.
Concurrent admin modifications merge safely at the CRDT
level (no data loss, no crash).

---

## Awareness (Cursors, Presence)

Awareness (cursor presence, selection state) is shared
via a lightweight y-webrtc room on a dummy Y.Doc that
carries no content. All peers join this room regardless
of capability level. The room is password-protected
using `awarenessRoomPassword` (included in every
capability URL) — every legitimate peer can join, but an
observer who only knows the IPNS name cannot eavesdrop
on presence information.
