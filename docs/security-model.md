# Security Model

Pokapali uses capability URLs, end-to-end encryption,
and CRDTs to provide collaborative documents without
trusting any server with your content. This document
explains what's protected, what's not, and why.

## Capability URLs

Access control is URL-based. Every document has up to
three URLs encoding different access levels:

| Level     | What's in the URL                               | What it allows                           |
| --------- | ----------------------------------------------- | ---------------------------------------- |
| **Admin** | readKey, ipnsKey, rotationKey, all channel keys | Read, write, publish, rotate, invite     |
| **Write** | readKey, ipnsKey, selected channel keys         | Read, write to granted channels, publish |
| **Read**  | readKey, awarenessRoomPassword                  | View content, see cursors                |

The URL's hash fragment contains the cryptographic
keys — the fragment is never sent to servers. Anyone
with the URL can access the document at that level.
No accounts, no server authentication.

**Generating invite links:**

```ts
// Write access to specific channels
const invite = await doc.invite({
  channels: ["content"],
});

// Read-only
const readInvite = await doc.invite({
  channels: [],
});
```

`doc.invite()` uses `narrowCapability()` internally
to produce a URL with only the keys needed for the
requested access level.

**Checking capabilities:**

```ts
doc.capability.isAdmin; // boolean
doc.capability.canPushSnapshots; // boolean
doc.capability.channels; // Set<string>
```

## Encryption

### What's encrypted

- **Document content** — each channel's Yjs state is
  encrypted with AES-256-GCM before being stored or
  transmitted as a snapshot. Each channel is encrypted
  independently.
- **Awareness/cursor data** — shared via a
  password-protected WebRTC room. The room password
  is derived from the document keys.
- **Snapshot blocks** — stored encrypted on IPFS
  and pinners. Pinners cannot read content.

### What's NOT encrypted

- **IPNS records** — these are public pointers from
  document name to latest snapshot CID. They reveal
  that a document exists and when it was last updated,
  but not its content.
- **IndexedDB storage** — local persistence is
  unencrypted. If device security is a concern, add
  application-level encryption before IndexedDB or
  use an encrypted filesystem.
- **GossipSub announcements** — the document's IPNS
  name and latest CID are announced publicly for peer
  discovery. Content remains encrypted.

### Key derivation

All keys are derived from a single admin secret using
HKDF-SHA256:

```
adminSecret (random, base64url)
  ├─ readKey      (AES-256, content decryption)
  ├─ ipnsKey      (Ed25519, snapshot publishing)
  ├─ rotationKey  (Ed25519, document recovery)
  ├─ channelKeys  (one per channel, room access)
  └─ awarenessRoomPassword (cursor sync)
```

Lower access levels receive only a subset of these
keys. A read-only URL contains only the readKey and
awarenessRoomPassword — enough to decrypt and follow
cursors, but not to publish or write to channels.

## Trust Model

### Relays and pinners

Relays forward encrypted traffic between peers.
Pinners store encrypted snapshot blocks and serve
them on request. Neither can read document content.

A relay or pinner can:

- See which IPNS names are active
- See when documents are updated (timing)
- Refuse to relay or store data (availability)

A relay or pinner cannot:

- Read document content
- Modify content without detection (CRDT merge +
  snapshot signatures prevent undetected tampering)
- Forge IPNS records (Ed25519 signatures)

### Peers

Peers with a read URL can see all content. Peers
with a write URL can edit channels they have keys
for. There is no per-edit access control — if a peer
has channel access, they can write anything to that
channel.

**Real-time edits** are structurally isolated: a peer
cannot join a channel's WebRTC room without the
correct room password (derived from the channel key).

**Snapshots** are the persistent form of document
state. Any peer with the `ipnsKey` can publish
snapshots. In permissionless mode (the default), all
writers can publish. In authorized mode, only peers
whose identity public keys are on the admin-managed
allowlist can publish.

### What pokapali does NOT protect against

1. **URL leakage** — if a URL is shared beyond its
   intended audience, recipients gain that access
   level permanently. Mitigation: admins can rotate
   the document via `doc.rotate()`, which creates a
   new identity and invalidates all existing URLs.

2. **Malicious writer** — a peer with write access
   can publish misleading content or stale snapshots.
   CRDTs ensure that other peers' edits aren't lost
   (merge recovers), but a malicious writer can add
   unwanted content. Mitigation: use authorized mode
   and monitor `doc.clientIdMapping` for attribution.

3. **Device compromise** — local storage is
   unencrypted. An attacker with device access can
   read all documents the device has opened.

4. **Traffic analysis** — an observer can see which
   IPNS names are active and when updates occur,
   even though content is encrypted.

5. **Per-edit attribution** — snapshots represent
   merged CRDT state from all peers, not individual
   edits. You can see who _published_ a snapshot
   (via the publisher signature), but not who wrote
   each individual character. Per-edit attribution
   is planned for a future release.

## Identity

Every device gets an Ed25519 identity keypair,
generated automatically and scoped per `appId`.
No configuration required.

```ts
doc.identityPubkey; // hex-encoded public key
```

**Publisher attribution:** Every snapshot includes the
publisher's public key and signature, verifiable by
any peer. This is always present regardless of
authorization mode.

**Participant verification:** The `clientIdMapping`
Feed maps Yjs client IDs to verified identity info:

```ts
const mapping = doc.clientIdMapping.getSnapshot();
for (const [clientId, info] of mapping) {
  // info.pubkey  — hex Ed25519 public key
  // info.verified — signature verified
}
```

Signatures bind a public key to a specific document
(preventing cross-document replay). Verification is
automatic.

## Document Recovery

If a document's IPNS record is compromised (e.g., a
malicious writer publishes a stale snapshot or freezes
the sequence number), the admin can rotate:

```ts
const result = await doc.rotate();
// result.newDoc — new Doc with fresh identity
// result.forwardingRecord — tells peers where to
//   find the new document
```

Rotation creates a new IPNS name and re-derives all
keys from a new admin secret. The old document
becomes read-only. Connected peers receive the
forwarding record automatically; offline peers need
the new URL.

## Channels

Channels provide independent encryption boundaries
within a document. Each channel has its own:

- Yjs subdoc (independent state)
- Encryption key (independent access)
- WebRTC room (independent sync)

A peer with access to channel A cannot read or write
channel B unless they also have B's key. This enables
patterns like a public "content" channel with a
restricted "comments" channel.

The `_meta` channel (internal) stores document
metadata including the publisher allowlist. Only
peers with primary channel write access can modify
`_meta`.
