---
"@pokapali/core": patch
"@pokapali/document": patch
---

Make codec required on Document.create() — prevents
the P0 runtime crash from !321 at the type level.
Clean up hardcoded yjsCodec in publish() by passing
codec through DocParams.
