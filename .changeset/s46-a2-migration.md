---
"@pokapali/store": patch
---

On-open migration from old per-concern IDB databases to
the unified Store. Copies identity seed from
`pokapali:identity:{appId}` and version-cache entries
from `pokapali:doc-cache` into the unified database.
Per-source tracking in meta store for crash-safe partial
recovery. Old databases preserved read-only (2-week
safety window).
