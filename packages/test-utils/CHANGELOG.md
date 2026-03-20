# @pokapali/test-utils

## 0.1.4

### Patch Changes

- [`0d0379c`](https://github.com/gnidan/pokapali/commit/0d0379c2d6098c7bbe49898e285e612dc90e0fd6)
  Add optional `httpUrl` parameter to `createTestRelay()` that publishes
  v2 node-caps via GossipSub, enabling E2E tests for pinner-provided
  tier badges and expiry countdowns.

## 0.1.3

### Patch Changes

- [#313](https://github.com/gnidan/pokapali/issues/313)
  [`69b9c5c`](https://github.com/gnidan/pokapali/commit/69b9c5c89969e565a66046316f8753a8917ec266)
  Add missing exports to api-stability.md
  (createTestRelay, TestRelay, TestRelayOptions,
  LatencyOptions) and update test-utils README with
  settle() method and createTestRelay section.

## 0.1.2

### Patch Changes

- [#314](https://github.com/gnidan/pokapali/issues/314)
  [`ca36041`](https://github.com/gnidan/pokapali/commit/ca36041bf3e5da46e6b6829a44b5204f47fbbf25)
  Fix package.json metadata: update test-utils
  description to reflect consumer-facing status, add
  missing engines field to react.
