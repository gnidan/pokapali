---
"@pokapali/test-utils": patch
---

Fix NaN timeout warning in test relay by adding
explicit reconnect backoff config, and fix flaky
version-history-tiers E2E tests by synchronizing
on mock pinner response before checking badges.
