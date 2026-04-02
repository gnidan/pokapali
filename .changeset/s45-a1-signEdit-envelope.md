---
"@pokapali/core": patch
---

Upgrade signEdit/verifyEdit to production 97-byte
envelope format: [1B version][32B pubkey][64B sig]
[NB payload]. verifyEdit now accepts an optional
trusted key set (hex-encoded pubkeys) and returns
null for any invalid input instead of throwing.
