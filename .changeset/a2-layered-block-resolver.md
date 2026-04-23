---
"@pokapali/protocol": minor
"@pokapali/core": patch
---

A2: layered BlockResolver + @pokapali/protocol package

- New packages/protocol package with createDocBlockResolver():
  LRU cache (10 MB default), IDB persistence, knownCids /
  memoryOnlyCids tracking, hydration lifecycle, onWriteError
  and onResolved callback seams for FailureStore wiring
- createLruCache(): byte-budget bounded LRU with onEvict
  callback for stale-ref cleanup
- 9-scenario parity test (stub vs real) prevents stub drift
- Core: 3 new subpath exports (block-resolver, fetch-block,
  test/stub-block-resolver)
