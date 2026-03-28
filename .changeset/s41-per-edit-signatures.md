---
"@pokapali/core": patch
"@pokapali/document": patch
---

Add per-edit Ed25519 signatures: signEdit and
verifyEdit wrappers, wire signing into Document
surface onLocalEdit callback.
