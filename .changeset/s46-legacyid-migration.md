---
"@pokapali/store": patch
---

Replace flag-based y-indexeddb migration with per-edit
legacyId tracking. Each migrated edit gets a sparse
unique `legacyId` field linking to its source record,
enabling idempotent insert, fast count-based
short-circuit, and per-edit resume after partial
migration. DB version bumped 2→3 to add the index and
clean up orphaned hydrate edits from the old flag-based
approach.
