---
"@pokapali/core": minor
---

Wire edit persistence and replay to unified Store.
Local edits, live-forwarded edits, and reconciliation
edits are persisted fire-and-forget via
Store.Document.History.append(). On startup, persisted
edits are replayed into Y.Docs using STORE_ORIGIN
(non-null origin prevents re-persistence loop). Runs
in parallel with y-indexeddb — both paths are
idempotent.
