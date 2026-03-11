# Design Principles

These are the architectural values behind Pokapali. They
explain _why_ things are built the way they are. Read this
before contributing code.

---

## URLs are capabilities

A Pokapali URL encodes everything needed to access a
document: the document identity (IPNS name in the path)
and the access level (key material in the fragment). Sharing
a URL shares a capability. There are no accounts, no tokens,
no sign-up flows. The URL _is_ the credential.

The fragment is never sent to servers. Browsers strip it
from HTTP requests by design, so capability material stays
on the client. This isn't a workaround — it's the
foundation of the access model.

Capabilities are narrowable: an admin URL can derive a
write URL, a write URL can derive a read URL, but never
the reverse. You share exactly the access level you intend.

## No privileged servers

There is no server that the system depends on for
correctness. Relays forward encrypted traffic they can't
read. Pinners store encrypted blocks they can't decrypt.
If every relay and pinner disappears, peers with the
document open keep working — they sync directly over
WebRTC and hold the full document state in memory.

This means: no hardcoded server URLs in library code. No
server-side authentication. No server that, if compromised,
leaks document content. Infrastructure is fungible —
anyone can run a relay or pinner, and clients discover them
via DHT, not configuration.

## Encryption is not optional

All persistent data (IPFS snapshots) is encrypted with
AES-GCM before it leaves the client. All real-time sync
(WebRTC rooms) is encrypted with the namespace access key.
Relays, pinners, and the DHT see only ciphertext.

This is structural, not policy. There is no "unencrypted
mode." The encryption keys are derived from the URL
fragment via HKDF, so possessing a URL is both necessary
and sufficient to read the content.

## Local-first, network-enhanced

Editing is local. Yjs CRDTs resolve conflicts
deterministically without coordination. A peer can edit
offline indefinitely and merge cleanly when reconnected.
The network enhances the experience (real-time cursors,
snapshot persistence) but is never required for the core
function of editing.

This shapes API design: `doc.channel("content")` returns a
`Y.Doc` synchronously. The editor mounts immediately.
Network state is observable (`status`, `loadingState`) but
never blocks the user.

## Writers sync in real-time, readers sync via snapshots

Peers with write access to a namespace join a WebRTC room
for that namespace and sync Yjs updates in real-time.
Peers with read-only access receive updates via periodic
GossipSub-announced, IPNS-polled snapshot fetches.

This is a deliberate asymmetry. Real-time sync requires
bidirectional state exchange; read-only access is
inherently one-directional. Snapshots are the natural
primitive for that — they're complete, verifiable, and
cacheable.

The tradeoff: read latency equals snapshot interval. This
is acceptable because read-only access is typically for
review, not co-editing.

## Pinners pull, writers don't push

Writers publish an IPNS record and announce the CID on
GossipSub. Pinners discover announcements and fetch blocks
themselves. Writers don't know which pinners exist, don't
push to specific servers, and don't need to.

This decouples writers from infrastructure. Adding a pinner
doesn't require writer configuration. Removing a pinner
doesn't break anything. The writer's only job is to publish
to IPNS and announce — the rest is the network's problem.

## Pinners are structurally zero-knowledge

Pinners validate block structure (CBOR schema, Ed25519
signature) but cannot verify _authorization_ — they don't
know which keys are allowed to publish. Authorization
requires decrypting `_meta` with `readKey`, which pinners
don't have.

This is by design. Pinners are untrusted infrastructure.
They store encrypted blobs, keep IPNS records alive on the
DHT, and serve blocks via bitswap. They can't read content,
can't forge snapshots (no signing key), and can't
selectively censor (any peer can run a pinner).

## Infrastructure is generic, not app-specific

Relays and pinners serve all apps on the network. App
identity (`appId`) is a public string baked into key
derivation and GossipSub topic names — it's a namespace,
not an authentication boundary. A single relay handles
traffic for every app. A pinner subscribing to an app's
announce topic pins snapshots from all documents in that
app.

This keeps infrastructure simple and shared. No per-app
server configuration. No app registration. Deploy a relay,
point it at the network, and it works for everyone.

## Every snapshot is a complete document

Snapshots are not deltas. Each one contains the full
`Y.encodeStateAsUpdate` for every namespace — a complete
document state. Any single snapshot CID is sufficient to
reconstruct the entire document at that point in time.

The `prev` chain links snapshots for version history, but
losing any node (or all but one) doesn't affect
recoverability. This is a strong guarantee: as long as one
snapshot survives anywhere in the network, the document is
recoverable.

## The library has no opinion on content or timing

Pokapali enforces which namespace access key gates which
subdocument. What lives in those subdocuments — rich text,
plain text, JSON, drawings — is the application's business.

Similarly, the library exposes `publish()` and emits
`publish-needed`, but when to snapshot is application
policy. The built-in `createAutoSaver` is a convenience,
not a requirement.

## No hardcoded peer addresses

No relay, pinner, or peer address is hardcoded in library
or infrastructure code. All relay discovery happens via DHT
(`findProviders` on a network-wide CID), peer exchange
(awareness-based relay sharing), or localStorage caching of
previously discovered relays. Relay-to-relay peering uses peer tagging (value 200) with
connections established via DHT discovery, not static
configuration.

The only hardcoded addresses are IPFS bootstrap nodes
(Protocol Labs public infrastructure) — these are needed
for initial DHT entry but are not pokapali-specific. Once
connected to the DHT, all further discovery is organic.

This principle ensures the network scales without
coordination. Adding a new relay requires only starting the
process and providing on the DHT — no client updates, no
config changes, no deploys. Removing a relay is equally
seamless: clients discover alternatives automatically.

## Trust is explicit and minimal

The trust model has clear boundaries:

- **Relays**: trusted to forward traffic, not to read it.
  Compromised relay = no content exposure (encrypted), but
  potential traffic analysis.
- **Pinners**: trusted to store blocks, not to understand
  them. Compromised pinner = no content exposure, but
  potential availability disruption.
- **Peers with `readKey`**: can read all namespaces. This
  is all-or-nothing by design — partial read access would
  require per-namespace encryption, adding complexity
  without clear benefit.
- **`canPushSnapshots`**: an independent trust flag, not
  implied by namespace write access. A peer can write to
  a namespace in real-time (via WebRTC) without being
  trusted to publish persistent snapshots. This is the
  main social trust boundary.
- **`rotationKey` (admin)**: can rotate the document's
  IPNS identity. The nuclear option. Don't share it.
