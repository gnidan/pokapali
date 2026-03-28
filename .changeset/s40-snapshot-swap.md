---
"@pokapali/core": patch
---

Replace subdocManager.encodeAll() with State view fold
in publish() for snapshot materialization. Falls back to
subdoc encoding when Document is not available.
