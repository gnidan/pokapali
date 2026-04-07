---
"@pokapali/core": patch
---

Merge pinner and cached version history sources.

The reactive versions feed is now the baseline for
the version list. Pinner HTTP results enrich entries
with tier/expiresAt metadata and are persisted to
Store so they survive refresh. Fixes race where
pinner returning only the tip overwrote the full
cached history.
