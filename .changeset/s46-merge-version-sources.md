---
"@pokapali/core": patch
---

Merge pinner and cached version history sources.

The versions feed (from Store cache) is now the
source of truth for the version list. Pinner HTTP
results enrich entries with tier/expiresAt metadata
and are persisted back to Store so they survive
refresh. Fixes race where pinner returning only the
tip overwrote the full cached history.
