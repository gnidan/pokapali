---
"@pokapali/core": patch
"@pokapali/store": patch
---

Fix y-indexeddb migration data loss (P0). Old migration
applied updates to Y.Doc with non-null origin, so
editHandler skipped persist — edits never reached Store.
Second load found Store empty + old DB marked done =
blank document.

Migration now runs at Store.create time in migrate.ts,
writing raw Yjs updates directly to the edits table.
Also adds \_meta channel persistence and replay so auth
state survives page refresh.
