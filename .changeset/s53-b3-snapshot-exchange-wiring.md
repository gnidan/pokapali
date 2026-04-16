---
"@pokapali/core": minor
---

Wire per-document snapshot exchange into
`reconciliation-wiring.ts`. When `getSnapshotCatalog`
and `blockResolver` are supplied, the wiring:

- Advertises the local catalog once per reconcile cycle
  after all per-channel coordinators report done
  (snapshot exchange is per-document, peer of the
  coordinator — not part of the per-channel edit loop).
- Routes snapshot messages via the new
  `sendSnapshotMessage` / `onSnapshotMessage` transport
  methods (snapshot messages have no channel).
- Verifies incoming blocks (CID hash + `validateSnapshot`)
  before storing via `blockResolver.put()` and
  dispatching to the optional `onSnapshotReceived`
  callback. Trust model stays owned by core.
