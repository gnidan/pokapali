---
"@pokapali/core": minor
---

Promote `_meta` from standalone Y.Doc to a proper
synced channel.

Library now prepends `_meta` to the channels array
internally. The `_meta` surface is created via
`document.surface("_meta")` like any other channel,
giving it edit capture, epoch tree, reconciliation,
and snapshot inclusion. `clientIdentities` and
`title` remain in the `_meta` channel Y.Doc.

Removed the standalone metaDoc creation, the special
`_meta` replay block, and the manual dirty-tracking
bridge — all now handled by the normal channel
pipeline.
