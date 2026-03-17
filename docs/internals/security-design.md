# Security Design: Announcement Authentication & Publisher Binding

Covers #75 (pinner identity verification) and #76
(publicKey→ipnsName binding). This document proposes
minimal protocol changes to close both gaps.

## Problem Statement

### Gap 1: Unauthenticated Announcements (#75)

Any GossipSub peer can announce a snapshot for any
IPNS name. The pinner accepts the claim, fetches the
CID, and re-announces it. There is no proof that the
announcer holds write capability for the document.

**Impact:** announcement spoofing, pinner resource
waste, snapshot chain pollution, traffic amplification.

### Gap 2: Unbound Publisher Identity (#76)

Snapshot `publisher` fields are self-claimed.
`validateStructure()` verifies the signature is
cryptographically valid but never checks whether the
publisher is authorized to publish for that IPNS name.
The `authorizedPublishers` list is enforced only in
browsers, never by pinners.

**Impact:** publisher spoofing in diagnostics,
unauthorized snapshot injection (readers without
authorization checks accept any structurally valid
snapshot).

## Current Trust Model

```
Announcement arrives via GossipSub
  → Pinner trusts ipnsName claim (NO VERIFICATION)
  → Pinner fetches CID
  → validateStructure() checks:
    ✓ doc signing key signature
    ✓ publisher signature (if present)
    ✗ publisher authorization
    ✗ announcer identity
  → Pinner re-announces to network
```

The only verification is structural: "this snapshot
was signed by _some_ valid key." There is no check
that the signer has authority over the document.

## Proposed Fix

### Tier 1: Signed Announcements (#75)

Add a `proof` field to the announcement format. The
announcer signs `ipnsName + cid` with the doc signing
key, proving they hold write capability.

**Announcement format change:**

```typescript
interface Announcement {
  ipnsName: string;
  cid: string;
  seq?: number;
  // NEW: proof of write capability
  proof?: string; // hex(sign(docKey, ipnsName + cid))
  // existing fields
  ack?: AnnouncementAck;
  block?: string;
  fromPinner?: boolean;
}
```

**Why the doc signing key?** Every writer derives it
from `ipnsKeyBytes` (part of write capability). Readers
don't have it. This proves the announcer holds at
least write access without revealing the capability
URL.

**Pinner verification:**

```typescript
// In onAnnouncement:
if (msg.proof) {
  // ipnsName IS the hex-encoded Ed25519 public key.
  // The pinner only needs the public key to verify —
  // it never has (or needs) ipnsKeyBytes (the seed).
  const pubKey = hexToBytes(msg.ipnsName);
  const payload = new TextEncoder().encode(msg.ipnsName + ":" + msg.cid);
  const valid = await ed25519.verify(hexToBytes(msg.proof), payload, pubKey);
  if (!valid) return; // reject
}
```

**Payload encoding:** `TextEncoder.encode(ipnsName +
":" + cid)` — the colon separator prevents ambiguity
between ipnsName and CID boundaries. Plain UTF-8 is
simpler than CBOR here since both inputs are already
hex strings.

**Migration:** Accept announcements without `proof`
during a transition period (1-2 alpha releases), then
require it. Log a warning for unproven announcements.

**Pinner re-announcements and acks:** When a pinner
re-announces a snapshot it previously verified, it
sets `fromPinner: true`. Pinners already trust each
other's re-announcements (they share appId). No proof
needed for re-announces or acks — the pinner verified
the original.

**Reader re-announcements:** Readers gossip CIDs they
receive (session-scoped dedup, reliability). They
don't hold the signing key and cannot produce proofs.
During the migration period, their unproven
re-announces are accepted. After migration, readers
can no longer re-announce. This is acceptable — reader
re-announces are a reliability optimization, not
essential for convergence. Pinners and writers cover
the announcement path.

### Tier 2: Publisher Authorization at Pinner (#76)

Extend the pinner to enforce publisher authorization
when the document has an authorization list.

**Challenge:** The `authorizedPublishers` list lives
in `_meta` (a Yjs subdoc), which is encrypted. The
pinner can't read it without the read key.

**Proposed approach — authorization hash in snapshot
header:**

Add an optional `authHash` field to the snapshot
node. When authorization is enabled, the publisher
includes `hash(sorted(authorizedPublishers))` in the
snapshot. The pinner can then:

1. Verify `publisher` is present when `authHash` is
   present
2. Cache the `authHash` per ipnsName
3. Reject snapshots where `authHash` changed but
   `publisher` is not in the new list

This is weaker than full authorization enforcement
(the pinner can't enumerate the list), but it
prevents the most dangerous attack: injecting
snapshots from unauthorized devices when auth is
enabled.

**Bootstrapping caveat:** The pinner trusts the first
`authHash` it sees for a given ipnsName. An attacker
who publishes first could set the initial hash. To
mitigate: the initial `authHash` should be signed by
the doc signing key (proving the setter has write
capability), and subsequent `authHash` changes should
only be accepted if the `publisher` was present in
the previous cached list. This anchors the
authorization chain to the doc owner. Full design
deferred to Tier 2 implementation.

**Full enforcement alternative:** Share the
authorization list with pinners in cleartext (as a
separate signed message or in the snapshot header).
This leaks publisher public keys to pinners but
enables full verification. Acceptable tradeoff for
most apps since publisher keys are already visible in
awareness.

**Recommendation:** Start with `authHash` (Tier 2a),
add cleartext list later if needed (Tier 2b).

### Tier 3: Rate Limiting by Peer (Enhancement)

Current rate limiting is per-ipnsName. Add
per-libp2p-peer rate limiting so a single attacker
can't exhaust the per-name budget across many docs:

```typescript
// Per peer: max 120 announcements/hour across
// all ipnsNames. Prevents sybil-style flooding.
const peerLimiter = createRateLimiter({
  maxPerHour: 120,
  key: evt.detail.from.toString(),
});
```

This is defense-in-depth, not a replacement for
signed announcements.

## Implementation Plan

### Phase 1 (this sprint): Design + Tier 1

1. Add `proof` field to `Announcement` interface
   (`announce.ts`)
2. Sign announcements in `announceSnapshot()`
   (`announce.ts`) — requires passing doc signing key
3. Verify proof in pinner's GossipSub handler
   (`node.ts`) and `onAnnouncement()` (`pinner.ts`)
4. Accept unproven announcements with warning log
   (migration period)
5. Tests: forged announcement rejected, valid
   announcement accepted, unproven announcement
   accepted with deprecation warning

**Files changed:**

- `packages/core/src/announce.ts` — format + signing
- `packages/node/src/pinner.ts` — verification
- `packages/node/bin/node.ts` — pass proof to handler

**Estimated scope:** ~50 lines changed, 3 files, 5-8
new tests.

### Phase 2 (future sprint): Tier 2a

1. Add `authHash` to snapshot format
   (`snapshot/src/index.ts`)
2. Pinner caches authHash per ipnsName
3. Pinner rejects snapshots with mismatched authHash
   when publisher is not in cached list
4. Browser includes authHash when publishing with
   authorization enabled

### Phase 3 (future sprint): Tier 2b + Tier 3

1. Cleartext authorization list in snapshot header
2. Per-peer rate limiting in pinner

## Security Properties After Fix

| Property                         | Before | After Tier 1 | After Tier 2 |
| -------------------------------- | ------ | ------------ | ------------ |
| Announcer holds write cap        | No     | Yes          | Yes          |
| Publisher is authorized          | No     | No           | Yes (hash)   |
| Pinner rejects spoofed announces | No     | Yes          | Yes          |
| Pinner enforces auth list        | No     | No           | Partial      |
| Per-peer rate limiting           | No     | No           | Yes (Tier 3) |

## Backwards Compatibility

- Tier 1 is backwards-compatible during migration:
  unproven announcements are accepted with a warning
- Tier 2 is backwards-compatible: snapshots without
  `authHash` are treated as permissionless
- No breaking changes to the public API

## Design Constraint: Edit Attribution

**The person who types on the keyboard must be the
person who gets attributed for the edit.**

This is a firm design principle. The security work
must not foreclose per-edit attribution, even though
full implementation is a future concern.

### What Each Tier Proves

It is critical to distinguish what each tier of
authentication actually proves:

- **Tier 1 (signed announcements)** proves the
  _announcer_ holds the doc signing key (write
  capability). It does NOT prove authorship of
  specific content within the snapshot. Any writer
  can announce any snapshot they produce.

- **Tier 2 (publisher binding)** proves the
  _publisher_ is in the authorization list. It
  does NOT prove the publisher authored every edit
  in the snapshot — a snapshot contains merged CRDT
  state from all peers.

- **Neither tier proves per-edit authorship.** That
  is a separate, harder problem.

### Path to Per-Edit Attribution

Yjs internally tracks which `clientID` authored
each edit operation in the CRDT. Auth Phase 1
(`clientIdentities` Y.Map in `_meta`) already maps
`clientID → { pubkey, sig }`, creating a chain:

```
edit → clientID → pubkey → identity
```

This chain exists today but is not enforced:

- `clientID` is a random number chosen per session.
  A malicious peer could claim another peer's
  `clientID`.
- The `clientIdentities` entry is self-asserted.
  Verification (`verifySignature` in
  `doc-identity.ts`) proves the registrant holds
  the private key matching `pubkey`, but doesn't
  prevent registration of a stolen or forged
  `clientID`.

**Future work (not in scope for Tiers 1-3):**

1. **Signed Y.Doc updates:** Each peer signs their
   Yjs update messages before broadcasting. Other
   peers verify before applying. This binds each
   CRDT operation to a specific identity key.
   Expensive (per-update crypto), but the only
   way to achieve true per-edit attribution in a
   CRDT.

2. **ClientID binding proof:** Extend the
   `clientIdentities` registration to include a
   challenge-response or nonce, preventing one peer
   from registering another's `clientID`.

3. **Snapshot attribution vs edit attribution:**
   Snapshots are full-document state. A snapshot
   publisher is NOT the author of every edit —
   they're the peer who serialized the merged
   state. Per-edit attribution requires inspecting
   the Yjs update log, not the snapshot publisher
   field.

### Phase 1 Compatibility

Phase 1 (signed announcements) is fully compatible
with future per-edit attribution:

- It operates at the announcement layer, not the
  edit layer. It doesn't touch `clientID` assignment
  or Yjs update propagation.
- The `clientIdentities` mapping is preserved and
  unmodified. Future work can build on it.
- Announcement proof uses the _doc signing key_
  (shared by all writers), not per-user identity
  keys. This is intentional — announcement auth
  answers "does this peer have write access?" not
  "who authored this content?"
- Nothing in Tier 1 conflates announcement auth
  with edit authorship. The distinction is clean.

## Non-Goals

- **End-to-end encryption of announcements** — the
  ipnsName and CID are already public on GossipSub.
  Proof adds authentication, not confidentiality.
- **Revoking individual device IPNS access** — this
  requires key rotation (`doc.rotate()`), which
  already exists.
- **Pinner-to-pinner authentication** — pinners
  already share an appId-scoped trust boundary via
  GossipSub topic subscriptions.
- **Per-edit attribution** — tracked as a future
  concern. The current tiers authenticate
  announcements and publishers, not individual
  edits. See "Design Constraint: Edit Attribution"
  above for the path forward.
