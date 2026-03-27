---
"@pokapali/document": patch
---

Add Document.surface(channel) for live editing
surfaces. Wires onLocalEdit → Edit → appendEdit
and syncs remote edits to the surface via
applyEdit. Surfaces are cached per channel and
cleaned up on destroy.
