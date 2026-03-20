---
"@pokapali/core": minor
---

#15 Add chain block prefetching after tip-advanced

After the tip advances, the interpreter now walks `prev` links
and dispatches fetches for up to `prefetchDepth` (default 3)
parent blocks. This catches pinner-index and cache-sourced
entries that the normal auto-fetch policy skips, reducing
sequential fetch latency during chain walks.

Set `prefetchDepth: 0` in DocParams to disable.
