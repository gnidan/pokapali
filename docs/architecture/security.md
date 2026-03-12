# Security

## Threat Model

### Threat 1: Peer forges an update to a channel they don't have access to

Each channel is a separate y-webrtc room,
password-protected using the channel access key bytes.
A peer without the access key cannot derive the room
password, cannot complete the signaling handshake, and
therefore cannot establish a WebRTC connection to inject
updates. **Structurally protected** — enforcement is at
connection establishment via room isolation, not by
filtering messages.

### Threat 2: Peer replays a captured update

y-webrtc syncs in a mesh — every peer in a room
receives every sync message. Replaying a previously
observed Yjs sync message is idempotent — CRDT state
doesn't change. **Protected by CRDT properties.**

### Threat 3: Peer escalates by modifying `_meta`

`_meta` is a channel in its own password-protected
y-webrtc room, accessible only to peers with the
primary channel's access key. **Structurally
protected.**

### Threat 4: Malicious `ipnsKey` holder

**Residual risk — two forms, unified mitigation.**

Any peer with `ipnsKey` (`canPushSnapshots`) can abuse
it in two ways:

**Form A — Malicious snapshot.** The attacker publishes
a crafted snapshot: stale state with `prev: null`
(severing history), or synthesized Yjs tombstones.
Peers with local IndexedDB state are unaffected — CRDT
merge corrects on next sync. The dangerous case is a
peer cold-bootstrapping with no live peers available.
_Recovery:_ admin uses `rotationKey` to point IPNS at
a known-good CID from the pinner's 24-hour history.

**Form B — seq freeze.** The attacker publishes an IPNS
record with `seq = 2^64 - 1`. The IPNS pointer is
permanently frozen. _Recovery:_ admin generates new
`adminSecret`, derives new IPNS keypair and name.
In-protocol forwarding from the old name is impossible.
The library checks a well-known IPFS forwarding path;
peers discover the new location via this path or
out-of-band.

**Unified mitigation:**

- `canPushSnapshots` is an explicit trust grant
- Pinners keep 24 hours of history for Form A rollback
- Rate limiting bounds flood cost
- `rotationKey` enables recovery from both forms

### Threat 5: External attacker (no URL)

Can observe IPNS names and fetch encrypted blocks.
Cannot decrypt, forge, or publish. **Fully locked out.**

### Threat 6: Pinning server misbehaves

Can observe IPNS names and encrypted blocks (neither
sensitive). Can refuse to pin (DoS, covered by other
pinners). Can serve a stale snapshot (degraded
bootstrap, not data loss — CRDT merge corrects on peer
connect). Cannot decrypt or forge. **Tolerable worst
case.**

### Threat 7: Relay node misbehaves

Forwards GossipSub signaling messages between browsers.
Can observe which IPNS names are active. Can block
connections (DoS, mitigated by multiple relays). Cannot
read content. **Tolerable worst case.**

### Threat 8: URL leak

Whoever finds the URL has that capability level — the
URL is the capability token. Mitigation is
admin-initiated rotation via `rotationKey`.

### Threat 9: Device compromise

Attacker can read IndexedDB contents (unencrypted Yjs
state) and likely recover the URL fragment from browser
history. **Not protected by default.** See
[persistence.md](persistence.md) for mitigation
options.

---

## Trust Boundaries

The trust model has clear boundaries:

- **Relays**: trusted to forward traffic, not to read
  it. Compromised relay = no content exposure
  (encrypted), but potential traffic analysis.
- **Pinners**: trusted to store blocks, not to
  understand them. Compromised pinner = no content
  exposure, but potential availability disruption.
- **Peers with `readKey`**: can read all channels.
  All-or-nothing by design.
- **`canPushSnapshots`**: independent trust flag, not
  implied by channel write access. A peer can write
  to a channel in real-time (via WebRTC) without being
  trusted to publish persistent snapshots. This is the
  main social trust boundary.
- **`rotationKey` (admin)**: can rotate the document's
  IPNS identity. Don't share it.

---

## What Pinners Can and Cannot Verify

Pinners **can** verify:

- Snapshot block is valid CBOR with expected schema
- Ed25519 signature is valid over block contents
- Block size is within limits
- Rate limits are not exceeded

Pinners **cannot** verify:

- Whether the publishing key is authorized (that
  information is in encrypted `_meta`)
- Whether the snapshot content is legitimate
- Anything about document content

Giving pinners `readKey` would let them read all
document content, collapsing the zero-knowledge
property. The tradeoff is that pinners pin snapshots
from _any_ holder of `ipnsKey`. This is acceptable
because `canPushSnapshots` is a trust boundary.
