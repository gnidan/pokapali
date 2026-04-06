---
"@pokapali/core": patch
---

Delete stale compat shims (document/document.ts and
channel/channel.ts) that duplicated @pokapali/document
interfaces behind misleading "re-export" comments.
Update test imports to use @pokapali/document directly.
