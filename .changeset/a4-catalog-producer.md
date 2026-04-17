---
"@pokapali/core": minor
---

A4: catalog producer + doc-runtime wiring

- Thread `getSnapshotCatalog`, `blockResolver`, and
  `onSnapshotReceived` through PeerSyncOptions to
  ReconciliationWiringOptions, enabling per-peer
  snapshot exchange
- Build catalog producer in create-doc.ts: derives
  SnapshotCatalog from localSnapshotHistory, filtered
  by resolver.getCached() availability
- Wire onSnapshotReceived → runtime.ingestSnapshot()
  for direct peer-to-peer snapshot delivery via
  catalog exchange (bypasses interpreter block-fetch)
- Expose ingestSnapshot(cid, data) on DocRuntimeResult
  for catalog-received peer blocks (source: "peer")
- Updated snapshot-ops comment: resolveSource retained
  for GossipSub backward compat until interpreter-
  double-apply cutover
