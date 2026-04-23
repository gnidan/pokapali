---
"@pokapali/core": patch
---

Push interpreter facts after catalog snapshot ingest

When the catalog exchange delivers a snapshot via
onSnapshotReceived, push a cid-discovered fact with the
inline block after successful ingest. This lets the
interpreter advance chain.tip for passive peers that
receive snapshots via catalog exchange (relay path),
fixing the gap where chain.tip stayed null and
deriveSaveState returned "unpublished" permanently.
