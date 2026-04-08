---
"@pokapali/crypto": patch
"@pokapali/blocks": patch
---

Add structured logging via @pokapali/log to crypto
and blocks packages. Key derivation, decryption
failures, snapshot encoding, chain walks, and
signature validation now emit debug/warn messages
for observability.
