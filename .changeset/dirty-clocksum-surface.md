---
"@pokapali/core": patch
---

Replace dirty tracking + clockSum with surface-based equivalents

Introduces a local `contentDirty` flag that replaces
`subdocManager.isDirty` / `markDirty()` / `on("dirty")`.
Rewires `computeClockSum()` to read from surface Y.Docs
instead of subdocManager Y.Docs. Removes
`subdocManager.encodeAll()` from publish — just resets
the local flag.
