---
"@pokapali/core": patch
"@pokapali/example": patch
---

Add Doc.surface() API and swap Editor.tsx from
doc.channel("content") to doc.surface("content"),
binding TipTap to the CodecSurface Y.Doc instead of
the SubdocManager Y.Doc.
