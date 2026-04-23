---
"@pokapali/core": minor
---

Add `createResolver` option to PokapaliConfig for
injecting a custom BlockResolver factory. Enables
apps to use `createDocBlockResolver` from
`@pokapali/protocol` for LRU-bounded memory with
knownCids persistence mirror, without core importing
protocol directly.
