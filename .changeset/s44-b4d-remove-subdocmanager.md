---
"@pokapali/core": patch
"@pokapali/sync": patch
---

Remove SubdocManager from core and sync packages.
Surface Y.Docs (from @pokapali/document) are now the
sole substrate for editing, dirty tracking, and channel
access. The internal subdocs/ directory is deleted.
