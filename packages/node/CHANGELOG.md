# @pokapali/node

## 0.1.2

### Patch Changes

- [#288](https://github.com/gnidan/pokapali/issues/288)
  [`f9b3060`](https://github.com/gnidan/pokapali/commit/f9b3060cd2c947113bc89541ca4902cf96a0bb6a)
  Validate snapshot before storing inline blocks
  in pinner blockstore. Previously, invalid blocks from
  GossipSub announcements were stored before validation,
  leaving garbage data in the blockstore.
- Updated dependencies
  - @pokapali/core@0.1.3
  - @pokapali/snapshot@0.1.2
