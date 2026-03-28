---
"@pokapali/core": patch
"@pokapali/document": patch
---

Route remote snapshot apply through epoch tree:
Channel.appendSnapshot records snapshot state as a
synthetic closed epoch, and CodecSurface.applyState
hydrates the live editing surface.
