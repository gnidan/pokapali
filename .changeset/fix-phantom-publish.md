---
"@pokapali/core": patch
---

#357 Fix phantom "Publish changes" appearing when
nothing has changed.

The identity registration write to `_meta`
(clientIdentities) now uses SNAPSHOT_ORIGIN so it
does not mark the document dirty. This was the
primary cause of the stale publish prompt — every
session generates a new clientID, producing a new
Y.Map entry that triggered the dirty flag even
without user edits.
