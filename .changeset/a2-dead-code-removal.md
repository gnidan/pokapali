---
"@pokapali/core": minor
"@pokapali/sync": patch
---

Remove dead code and deprecated compat shims:

- Remove unused ParallelVerifier from sync
- Remove sources.ts re-export barrel from core
- Remove deprecated Doc getters (provider, tipCid,
  ackedBy, guaranteeUntil, retainUntil, loadingState)
- Migrate example app to non-deprecated APIs
