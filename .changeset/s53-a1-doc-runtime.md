---
"@pokapali/core": patch
---

Extract `startP2PLayer` from `create-doc.ts` into a new
`doc-runtime.ts` module as `startDocRuntime()`. Pure
refactor — no behavior change. Reduces `create-doc.ts`
from 1959 to 1587 lines.
