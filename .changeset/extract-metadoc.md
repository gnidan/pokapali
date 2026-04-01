---
"@pokapali/core": patch
---

Extract metaDoc as standalone Y.Doc parameter

Decouples metaDoc from SubdocManager by introducing it
as an explicit `metaDoc: Y.Doc` parameter on `DocParams`
and `SnapshotOpsOptions`. Creates a shared
`SNAPSHOT_ORIGIN` symbol in `constants.ts` used by both
`Subdocs` and `doc-identity.ts`. The `channel("_meta")`
accessor now returns the standalone metaDoc.
