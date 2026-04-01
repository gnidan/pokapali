---
"@pokapali/core": patch
"@pokapali/codec": patch
"@pokapali/document": patch
---

Eager surfaces + persistence rewire

Eagerly creates surfaces for all channels at doc
creation. Rewires `createDocPersistence` to accept
a flat `Y.Doc[]` instead of subdocManager. Removes
`subdocManager.subdoc(ns)` from reconciliation bridge
— remote edits now flow through `channel.appendEdit`.
