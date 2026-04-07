---
"@pokapali/core": patch
---

Close IDBBlockstore on doc teardown to prevent
leaking IndexedDB connections.
