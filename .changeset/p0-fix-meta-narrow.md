---
"@pokapali/core": patch
"@pokapali/crypto": patch
---

Fix regression opening existing documents after
\_meta channel promotion. Derive `_meta` channel
key from readKey for pre-A2 URLs (migration) and
guard narrowCapability grants as defensive fallback.
