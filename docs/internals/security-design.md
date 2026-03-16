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
  const payload = encode(msg.ipnsName + msg.cid);
  const ipnsKeyBytes = hexToBytes(msg.ipnsName);
  const valid = await verifySignature(
    ipnsKeyBytes,
    hexToBytes(msg.proof),
    payload,
  );
  if (!valid) return; // reject
}
```

**Migration:** Accept announcements without `proof`
during a transition period (1-2 alpha releases), then
require it. Log a warning for unproven announcements.

**Pinner re-announcements:** When a pinner re-announces
a snapshot it previously verified, it sets
`fromPinner: true`. Pinners already trust each other's
re-announcements (they share appId). No proof needed
for re-announces — the pinner verified the original.

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
