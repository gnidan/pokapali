---
"@pokapali/document": patch
"@pokapali/core": patch
---

Add snapshot materialization equivalence property test
(State fold ≡ SubdocManager.encodeAll) and replace
Buffer.from with browser-safe bytesToHex in document
surface wiring.
