---
"@pokapali/core": patch
---

Re-tag received reconciliation edits as "sync" origin

Received edits arrived with origin "local" (set by the
sender) but the Document's surface editListener skipped
them, so remote edits entered the epoch tree but never
reached the surface Y.Doc. Re-tag to "sync" so the
editListener forwards them to surface.applyEdit().
