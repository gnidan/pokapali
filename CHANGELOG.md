# Changelog

All notable changes to this project will be documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0-alpha.6] — 2026-03-15

### Added

- **New package: `@pokapali/react`** — React hooks for
  pokapali integration (#228)
  - `useFeed<T>(feed)` — reactive Feed subscription
    via useSyncExternalStore
  - `useDocReady(doc, timeoutMs?)` — ready gate hook
  - `useAutoSave(doc, debounceMs?)` — auto-save
    lifecycle hook
  - `useDocDestroy(doc)` — cleanup on unmount
- **New package: `@pokapali/comments-tiptap`** —
  Tiptap adapter for comments (#82)
  - `anchorFromSelection(editor)` — one-liner anchor
    creation (replaces 15 lines of y-prosemirror
    wiring)
  - `resolveAnchors(commentsDoc, contentDoc,
    syncState)` — bulk ProseMirror position resolution
  - `CommentHighlight` — Tiptap extension for
    highlighting anchored text
  - `PendingAnchorHighlight` — Tiptap extension for
    unresolved anchor feedback
- `statusLabel(DocStatus)` and `saveLabel(SaveState)`
  — pure functions mapping status enums to
  human-readable labels
- `doc.snapshotEvents` Feed — reactive snapshot event
  notifications
- `doc.gossipActivity` Feed — reactive GossipSub
  activity state
- `doc.backedUp` Feed — true when current tip is
  acked by at least one pinner (#222)
- `doc.ready({ timeoutMs })` — optional timeout
  parameter, rejects on expiry (#227)
- Integration guide (docs/integration-guide.md)
- Stale-branch preflight in verify-branch.sh — fails
  fast before running full suite (#208)
- Release process guard: bin/release.sh (#201)
- Relay health-check cron with auto issue creation
  (#202)
- Churn module wired into nightly load test (#203)

### Changed

- **Event emitter replaced with Feeds** — `doc.on()`
  / `doc.off()` deprecated in favor of reactive Feed
  subscriptions (#189). Deprecated methods still work
  via Feed wrapper for backward compatibility.
- **Doc public surface reduced** (#187) — removed:
  `relays`, `lastSaveError`, `clockSum`, `ipnsSeq`,
  `latestAnnouncedSeq`, `hasAppliedSnapshot`,
  `history()`. Deprecated but kept: `provider`,
  `tipCid`, `ackedBy`, `guaranteeUntil`,
  `retainUntil`, `loadingState`.
- **create()/open() unified** — shared `initDoc()`
  path eliminates duplicated setup logic (#188)
- **create-doc.ts refactored** — 1942→1659 lines,
  3 modules extracted (doc-status, doc-identity,
  doc-gossip-bridge) (#183)
- Example app migrated to `@pokapali/comments-tiptap`
  imports (~358 lines removed)
- Example app: 11 of 17 `doc.on` calls migrated to
  Feed subscriptions

### Fixed

- `deriveLoadingState` flashes "failed" for transient
  fetch failures — now returns "retrying" with
  attempt count (#221)
- Misleading "offline" status during first 3-5s —
  `computeStatus` returns "connecting" during mesh
  grace period (#223)
- Awareness-only connection misleadingly reports
  "receiving" — now reports "connecting" until sync
  is established (#224)

## [0.1.0-alpha.5] — 2026-03-14

### Fixed

- Comments pane overlaps editor content when sidebar
  open — editor container now gets margin-right (#197)
- Comment button styling mismatch with share/history
  toolbar buttons (#198)
- Comment input overlap with spatially positioned
  comment threads (#196)
- bootstrapPeers config option not wired through to
  Helia (#195)
- Awareness cursor opacity reduced — remote selections
  no longer obscure text (#194)
- Comments ordered by document position instead of
  recency (#193)
- Display name shown instead of pubkey in comment
  authors (#191)
- Dependency version range inconsistencies across
  workspace packages (#112)
- engines field (node >=22) added to all package.json
  files (#111)
- Production IP removed from relay.ts JSDoc comment
- Hardcoded relay IPs removed from load test workflow

### Added

- `--no-tls` CLI flag for relay — skips autoTLS cert
  wait (used by ephemeral test relays)
- Tier 2 nightly load test workflow with ephemeral
  relay on test VPS (#173)
- Churn simulation for load testing — ChurnScheduler
  with proportional removal, writer protection (#172)
- Reader peer module for load testing — GossipSub
  subscriber with convergence tracking (#171)
- JSONL analysis script with configurable thresholds
  (#175)
- bin/loadtest-setup.sh — SSH key setup for test VPS
- 3 mechanical process guards: pre-commit main block,
  hardcoded IP check, tracked-gitignored check in
  verify-branch.sh
- block-resolver test coverage (#125)
- snapshot-codec and solo-mode test coverage (#126,
  #127)
- helia singleton race condition tests (#132)
- comments feed.ts and storage.ts tests (#134)
- 3 new Playwright E2E tests (65 total)

### Changed

- Deploy workflow: per-node fan-out GHA graph with
  graph visualization
- Nightly load test workflow: 4-job GHA graph (setup →
  load-test → stop-relay + metrics)
- CI workflow: parallel job graph with GHA
  visualization
- Docs refreshed: namespace→channel terminology,
  per-user identity marked implemented, Node >=22
- README updated for npm alpha release status
- deploy/nodes.json moved to GH secret
  (DEPLOY_NODES_CONFIG)

## [0.1.0-alpha.4] — 2026-03-14

### Fixed

- Comment popover: action moved from `onClick` to
  `onMouseDown` — prevents ProseMirror from collapsing
  its internal selection before the handler fires
- y-prosemirror mapping path fixed in all anchor
  resolvers (`syncState.mapping` → `syncState.binding
.mapping`) — comment creation and highlight rendering
  were silently failing in Editor.tsx,
  commentHighlight.ts, pendingAnchorHighlight.ts
- Closing comment sidebar no longer leaks pending anchor
  state
- `selectedCommentId` cleared on sidebar close
- Active comment highlight now propagates correctly to
  the commentHighlight extension
- Resolve/reopen/delete no longer throw on peer-deleted
  comments (try/catch added)
- `commentsDoc` moved to React state for stable reference
  (was re-obtained on every render)
- Deploy workflow: SSH config, health check commit hash
  comparison, deploy-setup already-installed check

### Added

- 31 new Playwright E2E tests (59 total): doc-loading
  (9), multi-peer editing (4), additional comment and
  version-history coverage
- `bin/verify-branch.sh` — automated pre-merge checks
  (tsc, format, tests, lint, shellcheck, actionlint)
  (#176)
- `bin/merge-branch.sh` — merge guard for team workflow
  (#178)
- `bin/check-memory-staleness.sh` — memory file
  staleness checker
- shellcheck + actionlint added to CI (#177)
- `bin/deploy-setup.sh` — automated deploy key setup
  for GHA relay deployments

### Changed

- Node CLI entry point uses `@pokapali/log` instead of
  `console.log`/`console.error` (#149)
- Deploy workflow: rolling batches with health checks,
  config-driven via `deploy/nodes.json`

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
