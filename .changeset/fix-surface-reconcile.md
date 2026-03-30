---
"@pokapali/core": patch
---

Trigger reconciliation for surface() edits

The edit bridge listened on subdocManager Y.Docs, but
doc.surface() creates a different Y.Doc via the codec.
Lazily register an update listener on the surface Y.Doc
so scheduleReconcile() fires when the user edits through
the surface path.
