# Changelog

All notable changes to this project will be documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0-alpha.14] — 2026-03-17

### Added

- Browser-side announcement signing — browsers now
  sign snapshot announcements before publishing,
  completing Phase 1 auth end-to-end
  ([#253](https://github.com/gnidan/pokapali/issues/253))
- Remote snapshot validation — snapshots from peers
  are now verified (CBOR structure, signatures,
  publisher attestation) before applying; tampered
  or unsigned blocks are rejected and the document
  stays alive
  ([#216](https://github.com/gnidan/pokapali/issues/216))
- Chain depth limit and cycle detection — walkChain
  now enforces a configurable max depth (default 1000) and detects cycles via visited-CID set,
  preventing DoS from unbounded or circular chains
  ([#78](https://github.com/gnidan/pokapali/issues/78))
- Global IPNS rate limit — pinners now enforce a
  sliding-window rate limit on new name admissions
  (`--max-new-names-per-hour`, default 100),
  preventing name-flood abuse; `newNameRejects`
  metric exposed via `/metrics`
  ([#77](https://github.com/gnidan/pokapali/issues/77))
- `doc.lastValidationError` Feed — surfaces snapshot
  validation failures to the UI; fires on rejection,
  resets on successful tip advance
  ([#216](https://github.com/gnidan/pokapali/issues/216))
- Validation warning banner — example app shows a
  dismissible amber banner when a malformed snapshot
  is rejected, with truncated CID for diagnostics
  ([#216](https://github.com/gnidan/pokapali/issues/216))

### Fixed

- Click+drag text selection — comment anchor cursor
  and collab cursor pointer-events no longer intercept
  drag; DragSafeCursors extension suppresses awareness
  cursor transaction rebuilds during drag operations
  ([#250](https://github.com/gnidan/pokapali/issues/250))

### Docs

- README refreshed — version bump to alpha.13,
  package table updated (added comments-tiptap,
  react), doc links expanded (api-stability,
  security-design, principles)

### Internal

- `gitea-api.sh` — fixed missing leading-slash
  normalization for API paths
- Mesh health status badges — relay availability,
  mesh connectivity, and pinned doc count via
  shields.io endpoint on GitHub Pages
  ([#262](https://github.com/gnidan/pokapali/issues/262))
- `.nojekyll` added to GitHub Pages deploy so
  shields.io badge endpoint renders correctly
  ([#262](https://github.com/gnidan/pokapali/issues/262))
- 20 new property tests — snapshot encrypt/decrypt
  round-trip, capability narrowing monotonicity,
  shouldAutoFetch policy, createFeed invariants
- 24 test gap tests — version-cache, relay-sharing,
  doc-rotate, topology-sharing coverage bolstered
  ([#130](https://github.com/gnidan/pokapali/issues/130),
  [#131](https://github.com/gnidan/pokapali/issues/131),
  [#133](https://github.com/gnidan/pokapali/issues/133),
  [#136](https://github.com/gnidan/pokapali/issues/136))
- New-name flood chaos scenario (S3) — 3-phase
  baseline/flood/recovery test exercising the IPNS
  rate limiter under aggressive churn
- Consumer integration tests for snapshot validation
  — 12 tests verifying rejection, error hierarchy,
  and graceful degradation from consumer perspective
  ([#216](https://github.com/gnidan/pokapali/issues/216))

## [0.1.0-alpha.13] — 2026-03-17

### Added

- Signed announcement proof verification — pinners
  validate that snapshot announcers hold the doc
  signing key before ingesting
  ([#75](https://github.com/gnidan/pokapali/issues/75))
- PublicKey-ipnsName binding — pinners verify the
  cryptographic link between publisher identity and
  IPNS name, rejecting mismatched announcements
  ([#76](https://github.com/gnidan/pokapali/issues/76))

### Fixed

- Click+drag text selection — CommentPopover no longer
  intercepts mousemove during drag operations
  ([#250](https://github.com/gnidan/pokapali/issues/250))
- Header responsive layout — mobile header no longer
  wraps, encryption tooltip no longer clips at edge
  ([#22](https://github.com/gnidan/pokapali/issues/22))
- `pinner-store.ts` Key function properly typed with
  `interface-datastore@^9` direct dependency
  ([#151](https://github.com/gnidan/pokapali/issues/151))
- TimeoutNaN warning on relay startup suppressed
  ([#56](https://github.com/gnidan/pokapali/issues/56))
- `Promise.withResolvers` polyfill for Node <22
  compatibility in test-utils
  ([#248](https://github.com/gnidan/pokapali/issues/248))
- Flaky pinner discovery test hardened with retry
  and increased timeout
  ([#249](https://github.com/gnidan/pokapali/issues/249))
- Unsafe `as any` casts on awareness state fields
  replaced with proper types (5 locations)
  ([#143](https://github.com/gnidan/pokapali/issues/143))

### Changed

- Interpreter decoupled from `create-doc.ts` —
  `SnapshotOps` interface extracted from
  `EffectHandlers` for testability
  ([#141](https://github.com/gnidan/pokapali/issues/141))
- `_reset*` test helpers removed from production
  bundles
  ([#147](https://github.com/gnidan/pokapali/issues/147))

### Tests

- `forwarding.ts` coverage expanded from 4 to 18
  tests — per-field tamper, encode/decode errors,
  CRUD operations
  ([#128](https://github.com/gnidan/pokapali/issues/128))
- `persistence.ts` coverage expanded from 4 to 14
  tests — empty namespace, slow provider, double
  destroy, handle shape verification
  ([#129](https://github.com/gnidan/pokapali/issues/129))

### Docs

- Consumer-facing docs refreshed — guide.md deprecated
  APIs replaced with Feed patterns, api-stability.md
  Feed tiers and deprecation catalogue added,
  architecture.md updated for relay split and node
  modules, deps.md internal packages documented,
  principles.md expanded, examples version pinning
  updated
  ([#251](https://github.com/gnidan/pokapali/issues/251))

## [0.1.0-alpha.12] — 2026-03-17

### Added

- Sync status indicator — `doc.status` and `doc.saveState` wired
  into visible UX with degraded-state warnings in the example app
  ([#212](https://github.com/gnidan/pokapali/issues/212))
- Block upload retry with exponential backoff — large snapshots
  no longer orphaned when relays are temporarily down
  ([#51](https://github.com/gnidan/pokapali/issues/51))
- Channel key warnings for pre-comments writers — `doc.channel()`
  warns on missing keys, `configuredChannels` getter exposes
  available channels for re-invite flows
  ([#79](https://github.com/gnidan/pokapali/issues/79))
- Generic relay — relay is now app-agnostic with dynamic
  GossipSub topic subscription, no longer requires app-specific
  pinner config
  ([#220](https://github.com/gnidan/pokapali/issues/220))
- Load-test baseline regression detection — automated nightly
  comparison against stored baselines with configurable
  thresholds
  ([#207](https://github.com/gnidan/pokapali/issues/207),
  [#206](https://github.com/gnidan/pokapali/issues/206))

### Fixed

- Silent error swallowing — all 5 `.catch(() => {})` locations
  replaced with structured logging
  ([#150](https://github.com/gnidan/pokapali/issues/150))
- Unsafe `as any` casts in node — replaced with proper typed
  access for GossipSub properties; 4 justified casts remain
  (blockstore/datastore boundary, private `backoff` field)
  ([#144](https://github.com/gnidan/pokapali/issues/144))
- `@types/d3-force` moved from production to dev dependencies
  in example app
  ([#113](https://github.com/gnidan/pokapali/issues/113))
- `Awareness` type re-exported from `@pokapali/core` — was
  exposed on `Doc` interface but not importable by consumers
  ([#117](https://github.com/gnidan/pokapali/issues/117))

### Changed

- Relay split — `relay.ts` (895 lines) decomposed into focused
  modules: connection management, topic handling, HTTP routes,
  and orchestration
  ([#160](https://github.com/gnidan/pokapali/issues/160))

### Tests

- Property tests for `async-utils` — 15 tests covering merge,
  scan, filter, take, timeout, and backpressure behaviors
  ([#135](https://github.com/gnidan/pokapali/issues/135))

### Docs

- CHANGELOG audited against full git history — 9 missing entries
  added across pre-alpha through alpha.7 releases
  ([#247](https://github.com/gnidan/pokapali/issues/247))
- All issue references converted to full GitHub links for
  correct rendering on npm and external contexts

## [0.1.0-alpha.11] — 2026-03-16

### Fixed

- Remove unsafe `as any` casts in example app — replaced with proper d3
  generics and CID typing across TopologyMap, VersionHistory, and
  useVersionHistory ([#152](https://github.com/gnidan/pokapali/issues/152))
- Remove stale TODO referencing closed issue [#20](https://github.com/gnidan/pokapali/issues/20) in helia.ts ([#155](https://github.com/gnidan/pokapali/issues/155))

### Docs

- JSDoc blocks on exported public interfaces — VersionInfo, SnapshotEvent,
  DocUrls now have documentation visible in editor tooltips ([#123](https://github.com/gnidan/pokapali/issues/123))
- `@internal` JSDoc markers on node package internal exports — clarifies
  public vs internal API boundary ([#122](https://github.com/gnidan/pokapali/issues/122))
- README for packages/load-test — covers purpose, setup, CLI flags, source
  layout, and nightly workflow ([#168](https://github.com/gnidan/pokapali/issues/168))

### Chore

- Package.json metadata — added description, keywords, homepage, repository,
  and author fields to all 14 packages ([#165](https://github.com/gnidan/pokapali/issues/165), [#166](https://github.com/gnidan/pokapali/issues/166))

### Tests

- Interpreter unit tests — 15 new tests covering cached block fast path, retry
  timer cancellation, publisher authorization, inline block chain discovery,
  cache-sourced newest-seq exception, and missing block guards ([#214](https://github.com/gnidan/pokapali/issues/214))
- IPNS helpers test coverage — 5 new tests for clockSum seq priority,
  missing delegated routing skip, publish queue coalescing, DHT fallback,
  and watchIPNS options object (8 → 13 total) ([#137](https://github.com/gnidan/pokapali/issues/137))

## [0.1.0-alpha.10] — 2026-03-16

### Added

- `useParticipants` React hook — subscribes to `clientIdMapping` Feed, returns
  live participant list without manual Feed wiring ([#233](https://github.com/gnidan/pokapali/issues/233))
- `useSnapshotFlash` React hook — triggers a brief visual flash on snapshot
  receipt for consumer UX feedback ([#234](https://github.com/gnidan/pokapali/issues/234))
- Reader convergence verification in chaos test infrastructure — `--readers N`
  flag threads through S1, S4, and weekly workflows; analyzer checks
  zero-tolerance convergence drift ([#217](https://github.com/gnidan/pokapali/issues/217))
- Lazy-init smoke E2E tests — Playwright tests verifying editor loads and
  accepts input after lazy Helia/WebRTC startup ([#200](https://github.com/gnidan/pokapali/issues/200))
- Security design spike — architecture docs for announcement authentication
  (Tier 1) and publisher binding (Tier 2), scoping implementation for
  Sprint 7 ([#75](https://github.com/gnidan/pokapali/issues/75), [#76](https://github.com/gnidan/pokapali/issues/76))

### Fixed

- Chain reducer property test bugs — three root causes: negative inferred seq
  from chain walk at genesis (parentSeq=0), orphan entries from block-fetched
  for undiscovered CIDs, and blockStatus regression from fetched to fetching on
  redundant fetch starts; also added missing save-error to valid states ([#243](https://github.com/gnidan/pokapali/issues/243))
- Pinner state maps unbounded growth — admission gate rejects unknown IPNS
  names at configurable `maxNames` cap (default 10,000), `lastQueryResponse`
  map cleaned up in `pruneIfNeeded`, new `capacityRejects` metric counter ([#53](https://github.com/gnidan/pokapali/issues/53))
- `contentType` silent mismatch in comments factory — throws on `XmlFragment`
  mismatch, warns when falling back to default content type ([#213](https://github.com/gnidan/pokapali/issues/213))
- Comment anchors break on paragraph splits — detect inverted anchors
  (start > end) from splits or deletions, surface `status: "inverted"` on
  `ResolvedAnchor` instead of silently dropping the comment ([#229](https://github.com/gnidan/pokapali/issues/229))
- Example app uses workspace deps instead of published packages — switched to
  published `@pokapali/*` dependencies with local alias overrides for
  development ([#163](https://github.com/gnidan/pokapali/issues/163))
- Flaky pinner guarantee query test — timing race between synchronous
  `nodeChangeHandler` registration and async `fireGuaranteeQuery` setup ([#244](https://github.com/gnidan/pokapali/issues/244))

## [0.1.0-alpha.9] — 2026-03-16

### Fixed

- Diagnostics warning spam before P2P ready — guard `buildDiagnostics()` with
  `isHeliaLive()` to avoid throwing during bootstrap ([#245](https://github.com/gnidan/pokapali/issues/245))
- Tiptap/comments-tiptap crash on editor init —
  `Cannot read 'nodeSize' of undefined` caused by comment anchor resolution
  racing editor creation; fixed IDB persistence recreation race and editor init
  ordering ([#246](https://github.com/gnidan/pokapali/issues/246))

## [0.1.0-alpha.8] — 2026-03-16

### Added

- Tier 3 chaos test infrastructure — S1 (relay kill)
  and S4 (peer churn) scenario scripts with fleet
  orchestration, phase-aware analysis, and weekly GHA
  workflow ([#174](https://github.com/gnidan/pokapali/issues/174))
- `--tcp-port` and `--ws-port` CLI flags for relay —
  enables multi-relay fleet testing
- Typed error subclasses — `PokapaliError`,
  `PermissionError`, `TimeoutError`, `DestroyedError`,
  `ValidationError`, `NotFoundError` for programmatic
  error handling by consumers
- `useFeed` accepts `null`/`undefined` — returns
  `undefined` instead of crashing, enabling
  `useFeed(instance?.feed)` pattern

### Changed

- Lazy WebRTC rooms — channels connect on demand
  instead of eagerly at init, reducing signaling
  traffic for unused channels ([#199](https://github.com/gnidan/pokapali/issues/199))
- Helia lifecycle refactored to discriminated union
  state machine (`idle` → `bootstrapping` → `ready`
  → `destroying`), fixing a race condition where
  `acquireHelia()` during `helia.stop()` could create
  duplicate instances ([#186](https://github.com/gnidan/pokapali/issues/186))
- Pinner lifecycle refactored to explicit phase enum
  (`created` → `running` → `stopped`), guarding
  public methods against post-stop calls ([#185](https://github.com/gnidan/pokapali/issues/185))
- `release.sh` now pushes to both GitHub and Gitea
  remotes automatically
- `guide.md` updated for lazy Helia startup,
  `lastPersistenceError` Feed, and bundle splitting
  patterns

## [0.1.0-alpha.7] — 2026-03-16

### Added

- Comments integration example — runnable
  Vite+React+Tiptap example at
  `docs/examples/comments/` covering channel setup,
  anchor creation, highlight extensions, spatial
  sidebar, threading, resolve/delete ([#209](https://github.com/gnidan/pokapali/issues/209))
- Migration guide for breaking changes across alpha
  releases (`docs/migration.md`) ([#162](https://github.com/gnidan/pokapali/issues/162))
- `lastPersistenceError` Feed classified as
  experimental in api-stability.md

### Changed

- Example app bundle split — 2.1MB monolith → 7KB
  initial load via dynamic core import, React.lazy
  editor, and manualChunks for P2P/editor deps ([#239](https://github.com/gnidan/pokapali/issues/239))
- Lazy Helia init — editor no longer blocks on Helia
  bootstrap, eliminating 5-15s blank screen on slow
  networks. P2P layer starts in background after
  local content is ready ([#200](https://github.com/gnidan/pokapali/issues/200))

### Fixed

- `applySnapshot()` silently dropped data for unknown
  channels — now auto-creates Y.Doc instances,
  preserving all channel data through snapshot
  round-trips ([#219](https://github.com/gnidan/pokapali/issues/219))
- Silent publish drop when no GossipSub mesh peers —
  announce now retries with backoff until mesh is
  available ([#225](https://github.com/gnidan/pokapali/issues/225))
- IDB quota errors silently swallowed — persistence
  failures now surface via `lastPersistenceError`
  Feed, preventing silent data loss in incognito
  mode ([#226](https://github.com/gnidan/pokapali/issues/226))
- Error messages across core and capability packages
  rewritten with actionable consumer guidance ([#164](https://github.com/gnidan/pokapali/issues/164))
- Keyboard selection popover a11y blocker — popover
  now responds correctly to keyboard-only selection
  ([#211](https://github.com/gnidan/pokapali/issues/211))
- `release.sh` fails when changelog is pre-committed
  under version heading — now handles both
  `[Unreleased]` and version-headed changelog, and
  `version-bump.mjs` sets `POKAPALI_RELEASE=1` ([#236](https://github.com/gnidan/pokapali/issues/236))
- Stale `namespaces` terminology in architecture.md updated to `channels`
  ([#161](https://github.com/gnidan/pokapali/issues/161))
- npm audit vulnerabilities resolved — updated transitive dependencies ([#237](https://github.com/gnidan/pokapali/issues/237))

## [0.1.0-alpha.6] — 2026-03-15

### Added

- **New package: `@pokapali/react`** — React hooks for
  pokapali integration ([#228](https://github.com/gnidan/pokapali/issues/228))
  - `useFeed<T>(feed)` — reactive Feed subscription
    via useSyncExternalStore
  - `useDocReady(doc, timeoutMs?)` — ready gate hook
  - `useAutoSave(doc, debounceMs?)` — auto-save
    lifecycle hook
  - `useDocDestroy(doc)` — cleanup on unmount
- **New package: `@pokapali/comments-tiptap`** —
  Tiptap adapter for comments ([#82](https://github.com/gnidan/pokapali/issues/82))
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
  acked by at least one pinner ([#222](https://github.com/gnidan/pokapali/issues/222))
- `doc.ready({ timeoutMs })` — optional timeout
  parameter, rejects on expiry ([#227](https://github.com/gnidan/pokapali/issues/227))
- Integration guide (docs/integration-guide.md)
- Stale-branch preflight in verify-branch.sh — fails
  fast before running full suite ([#208](https://github.com/gnidan/pokapali/issues/208))
- Release process guard: bin/release.sh ([#201](https://github.com/gnidan/pokapali/issues/201))
- Relay health-check cron with auto issue creation
  ([#202](https://github.com/gnidan/pokapali/issues/202))
- Churn module wired into nightly load test ([#203](https://github.com/gnidan/pokapali/issues/203))

### Changed

- **Event emitter replaced with Feeds** — `doc.on()`
  / `doc.off()` deprecated in favor of reactive Feed
  subscriptions ([#189](https://github.com/gnidan/pokapali/issues/189)). Deprecated methods still work
  via Feed wrapper for backward compatibility.
- **Doc public surface reduced** ([#187](https://github.com/gnidan/pokapali/issues/187)) — removed:
  `relays`, `lastSaveError`, `clockSum`, `ipnsSeq`,
  `latestAnnouncedSeq`, `hasAppliedSnapshot`,
  `history()`. Deprecated but kept: `provider`,
  `tipCid`, `ackedBy`, `guaranteeUntil`,
  `retainUntil`, `loadingState`.
- **create()/open() unified** — shared `initDoc()`
  path eliminates duplicated setup logic ([#188](https://github.com/gnidan/pokapali/issues/188))
- **create-doc.ts refactored** — 1942→1659 lines,
  3 modules extracted (doc-status, doc-identity,
  doc-gossip-bridge) ([#183](https://github.com/gnidan/pokapali/issues/183))
- **sources.ts refactored** — split into `feed.ts` (Feed public API),
  `async-utils.ts` (AsyncQueue, merge, scan), and `fact-sources.ts`
  (fact-stream iteration) ([#184](https://github.com/gnidan/pokapali/issues/184))
- Example app migrated to `@pokapali/comments-tiptap`
  imports (~358 lines removed)
- Example app: 11 of 17 `doc.on` calls migrated to
  Feed subscriptions

### Fixed

- `deriveLoadingState` flashes "failed" for transient
  fetch failures — now returns "retrying" with
  attempt count ([#221](https://github.com/gnidan/pokapali/issues/221))
- Misleading "offline" status during first 3-5s —
  `computeStatus` returns "connecting" during mesh
  grace period ([#223](https://github.com/gnidan/pokapali/issues/223))
- Awareness-only connection misleadingly reports
  "receiving" — now reports "connecting" until sync
  is established ([#224](https://github.com/gnidan/pokapali/issues/224))

## [0.1.0-alpha.5] — 2026-03-14

### Fixed

- Comments pane overlaps editor content when sidebar
  open — editor container now gets margin-right ([#197](https://github.com/gnidan/pokapali/issues/197))
- Comment button styling mismatch with share/history
  toolbar buttons ([#198](https://github.com/gnidan/pokapali/issues/198))
- Comment input overlap with spatially positioned
  comment threads ([#196](https://github.com/gnidan/pokapali/issues/196))
- bootstrapPeers config option not wired through to
  Helia ([#195](https://github.com/gnidan/pokapali/issues/195))
- Awareness cursor opacity reduced — remote selections
  no longer obscure text ([#194](https://github.com/gnidan/pokapali/issues/194))
- Comments ordered by document position instead of
  recency ([#193](https://github.com/gnidan/pokapali/issues/193))
- Display name shown instead of pubkey in comment
  authors ([#191](https://github.com/gnidan/pokapali/issues/191))
- Dependency version range inconsistencies across
  workspace packages ([#112](https://github.com/gnidan/pokapali/issues/112))
- engines field (node >=22) added to all package.json
  files ([#111](https://github.com/gnidan/pokapali/issues/111))
- Production IP removed from relay.ts JSDoc comment
- Hardcoded relay IPs removed from load test workflow

### Added

- `--no-tls` CLI flag for relay — skips autoTLS cert
  wait (used by ephemeral test relays)
- Tier 2 nightly load test workflow with ephemeral
  relay on test VPS ([#173](https://github.com/gnidan/pokapali/issues/173))
- Churn simulation for load testing — ChurnScheduler
  with proportional removal, writer protection ([#172](https://github.com/gnidan/pokapali/issues/172))
- Reader peer module for load testing — GossipSub
  subscriber with convergence tracking ([#171](https://github.com/gnidan/pokapali/issues/171))
- JSONL analysis script with configurable thresholds
  ([#175](https://github.com/gnidan/pokapali/issues/175))
- bin/loadtest-setup.sh — SSH key setup for test VPS
- 3 mechanical process guards: pre-commit main block,
  hardcoded IP check, tracked-gitignored check in
  verify-branch.sh
- block-resolver test coverage ([#125](https://github.com/gnidan/pokapali/issues/125))
- snapshot-codec and solo-mode test coverage ([#126](https://github.com/gnidan/pokapali/issues/126),
  [#127](https://github.com/gnidan/pokapali/issues/127))
- helia singleton race condition tests ([#132](https://github.com/gnidan/pokapali/issues/132))
- comments feed.ts and storage.ts tests ([#134](https://github.com/gnidan/pokapali/issues/134))
- Tier 1 CI smoke load test — fast GHA smoke check before nightly suite ([#170](https://github.com/gnidan/pokapali/issues/170))
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
- Comment popover button styled to match header toolbar buttons ([#190](https://github.com/gnidan/pokapali/issues/190))
- Comments panel opens on click of highlighted text ([#192](https://github.com/gnidan/pokapali/issues/192))
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
  ([#176](https://github.com/gnidan/pokapali/issues/176))
- `bin/merge-branch.sh` — merge guard for team workflow
  ([#178](https://github.com/gnidan/pokapali/issues/178))
- `bin/check-memory-staleness.sh` — memory file
  staleness checker
- shellcheck + actionlint added to CI ([#177](https://github.com/gnidan/pokapali/issues/177))
- `bin/deploy-setup.sh` — automated deploy key setup
  for GHA relay deployments

### Changed

- Node CLI entry point uses `@pokapali/log` instead of
  `console.log`/`console.error` ([#149](https://github.com/gnidan/pokapali/issues/149))
- Deploy workflow: rolling batches with health checks,
  config-driven via `deploy/nodes.json`

## [0.1.0-alpha.3] — 2026-03-13

### Fixed

- Helia singleton race conditions: concurrent
  `acquireHelia()` no longer creates duplicate instances,
  `releaseHelia()` during bootstrap no longer leaks
  ([#106](https://github.com/gnidan/pokapali/issues/106), [#107](https://github.com/gnidan/pokapali/issues/107))
- `snapshot-codec` unsafe `as any` cast replaced with
  proper typing ([#108](https://github.com/gnidan/pokapali/issues/108))
- `publish/**` tag convention for GHA publish workflow —
  `@` in tag names broke GitHub Actions triggers ([#100](https://github.com/gnidan/pokapali/issues/100))
- Publish workflow concurrency group now per-package,
  preventing parallel publish cancellation

### Added

- `Awareness` and `SubdocManager` re-exported from
  @pokapali/sync for advanced consumers ([#109](https://github.com/gnidan/pokapali/issues/109))
- `prepublishOnly` build step in @pokapali/comments and
  @pokapali/test-utils ([#110](https://github.com/gnidan/pokapali/issues/110))
- `doc.clientIdMapping` documented in api-stability.md
  and guide.md ([#103](https://github.com/gnidan/pokapali/issues/103))
- `workflow_dispatch` manual trigger for publish workflow
- 67 audit issues filed ([#102](https://github.com/gnidan/pokapali/issues/102)-[#168](https://github.com/gnidan/pokapali/issues/168)): 9 P1, 44 P2,
  14 P3 across 7 categories

## [0.1.0-alpha.2] — 2026-03-13

### Added

- Scenario-driven Playwright E2E test suite: 20 new tests
  covering share flow, comments UI, version history,
  publish/save, connection status, and error states
  ([#92](https://github.com/gnidan/pokapali/issues/92), [#96](https://github.com/gnidan/pokapali/issues/96), [#97](https://github.com/gnidan/pokapali/issues/97), [#98](https://github.com/gnidan/pokapali/issues/98), [#99](https://github.com/gnidan/pokapali/issues/99))
- `createTestRelay()` in @pokapali/test-utils — minimal
  libp2p node for fast E2E testing, <30ms startup ([#95](https://github.com/gnidan/pokapali/issues/95))
- `data-testid` attributes on 7 UI components for
  reliable E2E selectors ([#93](https://github.com/gnidan/pokapali/issues/93))
- `bootstrapPeers` URL parameter in example app for
  test relay injection ([#94](https://github.com/gnidan/pokapali/issues/94))
- Per-package git tags (`@pokapali/pkg@version`) and
  targeted publish workflow ([#100](https://github.com/gnidan/pokapali/issues/100))
- Systematic audit: 10 P1, ~50 P2, ~38 P3 findings
  across 7 categories ([#101](https://github.com/gnidan/pokapali/issues/101))

### Changed

- `yjs` moved from dependency to peerDependency in
  core, sync, and subdocs — prevents duplicate Yjs
  instances and silent CRDT corruption ([#104](https://github.com/gnidan/pokapali/issues/104))
- E2E test infrastructure: IDB isolation, port
  randomization, timeout rationalization ([#92](https://github.com/gnidan/pokapali/issues/92))

### Fixed

- `Capability` and `CapabilityGrant` types now
  re-exported from @pokapali/core ([#102](https://github.com/gnidan/pokapali/issues/102))

## [0.1.0-alpha.1] — 2026-03-13

### Added

- `exports` field in all package.json files for proper ESM
  resolution ([#14](https://github.com/gnidan/pokapali/issues/14))
- Generic anchor API in @pokapali/comments — works with any Yjs
  `AbstractType`, not just `Y.Text` ([#82](https://github.com/gnidan/pokapali/issues/82))
- @pokapali/test-utils package with in-memory test transport for
  multi-peer integration testing ([#87](https://github.com/gnidan/pokapali/issues/87))
- Latency simulation for test-utils — configurable delay/jitter
  with `settle()` API ([#88](https://github.com/gnidan/pokapali/issues/88))
- Playwright E2E test suite: 8 smoke tests + 4 multi-peer
  collaboration tests ([#86](https://github.com/gnidan/pokapali/issues/86))
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
  needed ([#23](https://github.com/gnidan/pokapali/issues/23))
- Package READMEs updated: removed "not published" banners, added
  install instructions
- Core README rewritten for consumer audience
- Getting-started example updated to use npm packages instead of
  file: links
- Test tautology audit: removed 4 tautological tests, replaced 1
  with meaningful assertion ([#89](https://github.com/gnidan/pokapali/issues/89))

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
  `Feed<ClientIdMapping>` ([#27](https://github.com/gnidan/pokapali/issues/27))
- @pokapali/comments package — threaded comments with anchored
  ranges, authorship verification, CRDT-based conflict
  resolution (43 tests)
- Comment UI: sidebar with threading, anchor highlighting,
  resolve/reopen/delete flows
- Pinner HTTP endpoints: `/tip/:name` for fast snapshot fetch with
  parallel IPNS race, `/block/:cid` for block upload/download,
  `/guarantee/:name` for guarantee queries ([#36](https://github.com/gnidan/pokapali/issues/36))
- `doc.saveState` Feed surfaces auto-save errors to
  applications ([#50](https://github.com/gnidan/pokapali/issues/50))
- HTTP tip fetch with parallel IPNS race in browser via
  `fetch-tip.ts` ([#36](https://github.com/gnidan/pokapali/issues/36))
- `doc.identityPubkey` and `doc.lastSaveError` properties on Doc

### Changed

- BlockResolver refactor: unified block fetch/write paths with
  `get()` (memory->IDB->HTTP->bitswap), `getCached()`
  (sync memory-only), `put()` (memory+IDB) ([#72](https://github.com/gnidan/pokapali/issues/72))
- Renamed `snapshot-lifecycle.ts` -> `snapshot-codec.ts` (part of
  BlockResolver refactor)
- IDB version index cache for offline version history access
- Version history UI retries loading instead of eagerly marking
  versions unavailable ([#64](https://github.com/gnidan/pokapali/issues/64))

### Fixed

- HTTP block upload timeout — slow clients can no longer hold
  connections indefinitely ([#52](https://github.com/gnidan/pokapali/issues/52))
- Pre-existing documents crash from missing comments channel ([#80](https://github.com/gnidan/pokapali/issues/80))
- Yjs type conflict — XmlFragment vs Y.Text on content
  channel ([#81](https://github.com/gnidan/pokapali/issues/81))
- Auth test gaps: self-deauth, admin gate, signature verification,
  round-trip, migration, rotation ([#70](https://github.com/gnidan/pokapali/issues/70))
- Empty blocks from blockstore/HTTP silently fail CBOR decode — now treated
  as misses with retry, guarding all decode sites ([#60](https://github.com/gnidan/pokapali/issues/60))
- Gossip property test assertion fix — allow `ts=0`, recompute
  `newestFetched` on block-fetch-failed ([#61](https://github.com/gnidan/pokapali/issues/61))
- History and `loadVersion()` blocks only cached in memory — now persisted
  to IDB, eliminating re-fetch on page reload ([#66](https://github.com/gnidan/pokapali/issues/66))

### Tests

- 22 unit tests for doc-diagnostics, create-doc, and doc-rotate ([#48](https://github.com/gnidan/pokapali/issues/48))

### Security

- Adversarial threat model scoped ([#28](https://github.com/gnidan/pokapali/issues/28)) — identified 4 security
  issues:
  - Pinner identity verification: forged acks /
    guarantees ([#75](https://github.com/gnidan/pokapali/issues/75))
  - No publicKey-ipnsName binding: snapshot overwrite
    attack ([#76](https://github.com/gnidan/pokapali/issues/76))
  - No global rate limit on new IPNS names ([#77](https://github.com/gnidan/pokapali/issues/77))
  - No chain depth/cycle protection in walkChain ([#78](https://github.com/gnidan/pokapali/issues/78))

## Version History — 2026-03-11

### Added

- Version history APIs: `doc.versionHistory()`,
  `doc.loadVersion()`, chain state wiring
- `doc.versions` Feed — reactive version history with chain walk
  progress
- Pinner version thinning with retention tiers: 14-day retention,
  tiered snapshot thinning
- Clock skew tolerance for `guaranteeUntil` ([#44](https://github.com/gnidan/pokapali/issues/44))
- Stale IPNS name pruning ([#57](https://github.com/gnidan/pokapali/issues/57))

### Changed

- **BREAKING**: `namespace` renamed to `channel` in all public APIs
- `doc.history()` deprecated — use `doc.versions` Feed instead

### Fixed

- IPNS throttle: serialize concurrent `acquire()` callers
- Private GossipSub `.mesh` access replaced with public API
  ([#4](https://github.com/gnidan/pokapali/issues/4), [#5](https://github.com/gnidan/pokapali/issues/5), [#6](https://github.com/gnidan/pokapali/issues/6))
- Interpreter crash now resolves `ready()` instead of
  hanging ([#39](https://github.com/gnidan/pokapali/issues/39))

## State Management Redesign — 2026-03-10

### Added

- Fact-stream state architecture ([#1](https://github.com/gnidan/pokapali/issues/1)): `facts.ts` (27 fact
  variants), `reducers.ts` (pure state derivation), `sources.ts`
  (async iteration), `interpreter.ts` (effect dispatcher). 7-step
  rewrite replacing snapshot-watcher
- IndexedDB persistence for Yjs state and IPFS blocks ([#20](https://github.com/gnidan/pokapali/issues/20))
- GossipSub message size enforcement ([#42](https://github.com/gnidan/pokapali/issues/42))
- IPNS delegated routing rate limiting ([#33](https://github.com/gnidan/pokapali/issues/33))
- GossipSub mesh observability: `/metrics` endpoint
  enhancements ([#11](https://github.com/gnidan/pokapali/issues/11))
- Cross-package integration tests ([#7](https://github.com/gnidan/pokapali/issues/7))
- Property-based tests: crypto, capability, snapshot,
  reducers ([#25](https://github.com/gnidan/pokapali/issues/25), [#26](https://github.com/gnidan/pokapali/issues/26))

### Changed

- Pinner store: `state.json` replaced with LevelDB-backed
  store ([#32](https://github.com/gnidan/pokapali/issues/32))
- Mesh stability: `Dlo=3`, capped backoff, health check
