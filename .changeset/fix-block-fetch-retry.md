---
"@pokapali/core": patch
"@pokapali/example": patch
---

Cap block fetch retries: version history diff preload
stops after 3 failed attempts per CID, and block-resolver
caches misses for 60s to avoid redundant network requests.
