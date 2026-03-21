# @pokapali/node

## 0.1.3

### Patch Changes

- [#376](https://github.com/gnidan/pokapali/issues/376)
  [`d2f35fa`](https://github.com/gnidan/pokapali/commit/d2f35fa689ce0d5f6d3f3761387aba0be3e28e9a)
  Fix startup stale-resolve mass deletion.

  Add STARTUP_GRACE_MS (10 minutes) that skips
  stale-resolve pruning immediately after pinner
  start. On restart, lastResolvedAt is stale because
  resolveAll() runs async — without this grace, every
  doc looks stale and gets deleted.

  Also adds periodic pruning (hourly) so stale-resolve
  still fires after the grace window expires. Previously
  pruneIfNeeded() only ran at startup.

- [#376](https://github.com/gnidan/pokapali/issues/376)
  [`e295e79`](https://github.com/gnidan/pokapali/commit/e295e791972ad7b66ee18d1ed777f0dcc4b13e73)
  Fix stale-resolve pruning to deactivate instead of delete, honoring
  14-day retention window. Adds startup grace period to prevent
  mass-pruning on restart.

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
