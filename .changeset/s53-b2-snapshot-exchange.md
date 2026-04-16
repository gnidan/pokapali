---
"@pokapali/sync": minor
---

Snapshot exchange sub-protocol (S53 B2).

- Extend reconciliation transport with
  sendSnapshotMessage / onSnapshotMessage APIs
  (channelNameLen=0 wire discriminator for
  snapshot frames)
- Add createSnapshotExchange state machine:
  per-document peer of the channel-level
  coordinator, handling SNAPSHOT_CATALOG /
  SNAPSHOT_REQUEST / SNAPSHOT_BLOCK exchange
- ~200KB chunking via offset/total, NAK via
  empty block + total=0
- Default selection policy: tip first, then
  descending seq, capped at budget (10)
- Default block verification: sha256(data)
  matches CID multihash digest + validateSnapshot
  succeeds
- Defensive drops for cross-routed messages
  (snapshot-typed in channel frame or vice
  versa); session.ts throws on snapshot types
  as routing-invariant
