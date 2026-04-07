---
"@pokapali/core": minor
"@pokapali/store": patch
---

Wire unified Store into core. Identity persistence now
uses Store.Identity instead of a separate IDB database.
Version cache replaced by Store.Document.Snapshots
(individual append per discovery, idempotent upsert).
Store.Document handle threaded to createDoc for
per-document snapshot metadata persistence.

Also fixes two Store review items: destroy() uses
Promise.all for concurrent cursor deletion (prevents
IDB transaction auto-commit), and snapshots.append
uses put() for idempotent upsert.
