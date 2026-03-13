# Changelog

All notable changes to this project will be documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0-alpha.3] — 2026-03-13

### Fixed

- Helia singleton race conditions: concurrent
  `acquireHelia()` no longer creates duplicate instances,
  `releaseHelia()` during bootstrap no longer leaks
  (#106, #107)
- `snapshot-codec` unsafe `as any` cast replaced with
  proper typing (#108)
- `publish/**` tag convention for GHA publish workflow —
  `@` in tag names broke GitHub Actions triggers (#100)
- Publish workflow concurrency group now per-package,
  preventing parallel publish cancellation

### Added

- `Awareness` and `SubdocManager` re-exported from
  @pokapali/sync for advanced consumers (#109)
- `prepublishOnly` build step in @pokapali/comments and
  @pokapali/test-utils (#110)
- `doc.clientIdMapping` documented in api-stability.md
  and guide.md (#103)
- `workflow_dispatch` manual trigger for publish workflow
- 67 audit issues filed (#102-#168): 9 P1, 44 P2,
  14 P3 across 7 categories

## [0.1.0-alpha.2] — 2026-03-13

### Added

- Scenario-driven Playwright E2E test suite: 20 new tests
  covering share flow, comments UI, version history,
  publish/save, connection status, and error states
  (#92, #96, #97, #98, #99)
- `createTestRelay()` in @pokapali/test-utils — minimal
  libp2p node for fast E2E testing, <30ms startup (#95)
- `data-testid` attributes on 7 UI components for
  reliable E2E selectors (#93)
- `bootstrapPeers` URL parameter in example app for
  test relay injection (#94)
- Per-package git tags (`@pokapali/pkg@version`) and
  targeted publish workflow (#100)
- Systematic audit: 10 P1, ~50 P2, ~38 P3 findings
  across 7 categories (#101)

### Changed

- `yjs` moved from dependency to peerDependency in
  core, sync, and subdocs — prevents duplicate Yjs
  instances and silent CRDT corruption (#104)
- E2E test infrastructure: IDB isolation, port
  randomization, timeout rationalization (#92)

### Fixed

- `Capability` and `CapabilityGrant` types now
  re-exported from @pokapali/core (#102)

## [0.1.0-alpha.1] — 2026-03-13

### Added

- `exports` field in all package.json files for proper ESM
  resolution (#14)
- Generic anchor API in @pokapali/comments — works with any Yjs
  `AbstractType`, not just `Y.Text` (#82)
- @pokapali/test-utils package with in-memory test transport for
  multi-peer integration testing (#87)
- Latency simulation for test-utils — configurable delay/jitter
  with `settle()` API (#88)
- Playwright E2E test suite: 8 smoke tests + 4 multi-peer
  collaboration tests (#86)
- Google Docs-style comment popover — floating button near text
  selection, creates anchors using Y.RelativePositions
- Consumer getting-started example
  (`docs/examples/getting-started/`)
- `docs/getting-started.md` quick-start tutorial
- `docs/api-stability.md` export classification
  (stable / experimental / internal)
- GitHub Actions publish workflow — tag-triggered npm publish
  (v\* tags)
- `bin/version-bump.mjs` — per-package version bumps with
  transitive dependency cascade
- Package READMEs for @pokapali/comments and @pokapali/test-utils
- `CONTRIBUTING.md` with lockfile conflict recipe, version bump
  and publishing docs
- WSS addresses in relay capability messages for improved peer
  discovery

### Changed

- npm publish: all 10 packages published as
  @pokapali/\* 0.1.0-alpha.0
- Comment creation flow redesigned: select text -> click popover
  -> type in sidebar
- Docs reorganized: consumer-facing docs at `docs/` top level,
  internals moved to `docs/internals/`
- Factory naming convention audited and documented — 6 patterns
  (bare/createX/startX/setupX/deriveX/generateX), no renames
  needed (#23)
- Package READMEs updated: removed "not published" banners, added
  install instructions
- Core README rewritten for consumer audience
- Getting-started example updated to use npm packages instead of
  file: links
- Test tautology audit: removed 4 tautological tests, replaced 1
  with meaningful assertion (#89)

### Fixed

- Comment popover restricted to editor selections only (was
  appearing for any text selection)
- Popover position clamped to viewport on all edges
- Guard against undefined y-prosemirror mapping during
  Collaboration plugin init
- Auto-focus comment textarea when sidebar opens with pending
  anchor
- AbstractType<unknown> Yjs type variance — use AbstractType<any>
  for compatibility
- `.length` on AbstractType — use `._length`
- Eslint config: ignore `.worktrees/`, add Node globals for `bin/`
  scripts (461 errors fixed)
- Exclude test files from app tsconfig build
- Test files excluded from npm tarballs via `files` field
- Relay discovery: timeout handling, re-dial on disconnect, startup
  sequencing improvements

## [0.1.0-alpha.0] — 2026-03-13

First public npm release. 10 packages published.

## Comments & Attribution — 2026-03-12

### Added

- Auth Phase 1: per-user identity with clientID->pubkey mapping in
  `_meta` subdoc, signed registration,
  `Feed<ClientIdMapping>` (#27)
- @pokapali/comments package — threaded comments with anchored
  ranges, authorship verification, CRDT-based conflict
  resolution (43 tests)
- Comment UI: sidebar with threading, anchor highlighting,
  resolve/reopen/delete flows
- Pinner HTTP endpoints: `/tip/:name` for fast snapshot fetch with
  parallel IPNS race, `/block/:cid` for block upload/download,
  `/guarantee/:name` for guarantee queries (#36)
- `doc.saveState` Feed surfaces auto-save errors to
  applications (#50)
- HTTP tip fetch with parallel IPNS race in browser via
  `fetch-tip.ts` (#36)
- `doc.identityPubkey` and `doc.lastSaveError` properties on Doc

### Changed

- BlockResolver refactor: unified block fetch/write paths with
  `get()` (memory->IDB->HTTP->bitswap), `getCached()`
  (sync memory-only), `put()` (memory+IDB) (#72)
- Renamed `snapshot-lifecycle.ts` -> `snapshot-codec.ts` (part of
  BlockResolver refactor)
- IDB version index cache for offline version history access
- Version history UI retries loading instead of eagerly marking
  versions unavailable (#64)

### Fixed

- HTTP block upload timeout — slow clients can no longer hold
  connections indefinitely (#52)
- Pre-existing documents crash from missing comments channel (#80)
- Yjs type conflict — XmlFragment vs Y.Text on content
  channel (#81)
- Auth test gaps: self-deauth, admin gate, signature verification,
  round-trip, migration, rotation (#70)

### Security

- Adversarial threat model scoped (#28) — identified 4 security
  issues:
  - Pinner identity verification: forged acks /
    guarantees (#75)
  - No publicKey-ipnsName binding: snapshot overwrite
    attack (#76)
  - No global rate limit on new IPNS names (#77)
  - No chain depth/cycle protection in walkChain (#78)

## Version History — 2026-03-11

### Added

- Version history APIs: `doc.versionHistory()`,
  `doc.loadVersion()`, chain state wiring
- `doc.versions` Feed — reactive version history with chain walk
  progress
- Pinner version thinning with retention tiers: 14-day retention,
  tiered snapshot thinning
- Clock skew tolerance for `guaranteeUntil` (#44)
- Stale IPNS name pruning (#57)

### Changed

- **BREAKING**: `namespace` renamed to `channel` in all public APIs
- `doc.history()` deprecated — use `doc.versions` Feed instead

### Fixed

- IPNS throttle: serialize concurrent `acquire()` callers
- Private GossipSub `.mesh` access replaced with public API
  (#4, #5, #6)
- Interpreter crash now resolves `ready()` instead of
  hanging (#39)

## State Management Redesign — 2026-03-10

### Added

- Fact-stream state architecture (#1): `facts.ts` (27 fact
  variants), `reducers.ts` (pure state derivation), `sources.ts`
  (async iteration), `interpreter.ts` (effect dispatcher). 7-step
  rewrite replacing snapshot-watcher
- IndexedDB persistence for Yjs state and IPFS blocks (#20)
- GossipSub message size enforcement (#42)
- IPNS delegated routing rate limiting (#33)
- GossipSub mesh observability: `/metrics` endpoint
  enhancements (#11)
- Cross-package integration tests (#7)
- Property-based tests: crypto, capability, snapshot,
  reducers (#25, #26)

### Changed

- Pinner store: `state.json` replaced with LevelDB-backed
  store (#32)
- Mesh stability: `Dlo=3`, capped backoff, health check
