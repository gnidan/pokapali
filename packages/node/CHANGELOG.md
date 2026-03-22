# @pokapali/node

## 0.1.4

### Patch Changes

- [`40fd9c0`](https://github.com/gnidan/pokapali/commit/40fd9c005860f7407ae4ee64f9fe1763627caf27)
  Make saveHistoryIndex atomic via write-to-tmp + rename,
  preventing corrupt index files on crash
  ([#380](https://github.com/gnidan/pokapali/issues/380))
- [#378](https://github.com/gnidan/pokapali/issues/378)
  [`5051909`](https://github.com/gnidan/pokapali/commit/505190981eb4791ba8e8133aec3fcd79a4ea5622)
  Replace startup grace timer with resolveAll
  completion flag.

  Stale-resolve pruning is now gated on resolveAll()
  having completed at least once, instead of a 10-minute
  time-based grace window. This is the proper state-based
  fix for the [#376](https://github.com/gnidan/pokapali/issues/376)
  startup mass-deletion bug — pruning
  waits for fresh lastResolvedAt data rather than guessing
  how long resolveAll() takes.

- [`d8b13db`](https://github.com/gnidan/pokapali/commit/d8b13db3b370b056932ee69a2174c65bb9d6189a)
  Capture uncaptured relay setTimeout handles (45s
  initial provide, 15s cert re-dial) and clear them
  in stop() to prevent leaked timers
  ([#381](https://github.com/gnidan/pokapali/issues/381))
- Updated dependencies
  - @pokapali/core@0.1.6

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
