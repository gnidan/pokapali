---
"@pokapali/core": patch
"@pokapali/finger-tree": patch
---

Add EpochIndex monoid and EpochTree type for O(log n) epoch navigation. Loosen combine() generic constraint from Record<string, unknown> to object so interfaces with readonly/non-index-signature fields work.
