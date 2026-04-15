---
"@pokapali/core": patch
---

Extract edit bridge from create-doc into
edit-bridge.ts module

Move the CodecSurface onEdit wiring,
ensureSurfaceBridged, and fallback surface
management into a dedicated createEditBridge()
factory. Pure refactor — no behavior change.
