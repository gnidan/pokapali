---
---

ci: run CI on PRs targeting any branch

Remove branch filter from pull_request trigger so
PRs targeting non-main branches (e.g. stacked PRs)
also get CI checks.
