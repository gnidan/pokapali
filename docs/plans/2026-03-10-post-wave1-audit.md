# Post-Wave-1 Comprehensive Audit

**Date:** 2026-03-10
**Scope:** All changes since the post-topology audit (Wave 1 +
subsequent fixes + CI/tooling)

---

## Wave 1 Task Status

| #   | Task                        | Status                                                                                                                    |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | index.ts decomposition      | Partial — topologyGraph extracted (197 lines), index.ts still 1326 lines, \_meta dedup pending                            |
| 2   | IPNS parallel republish     | Done — bounded concurrency=5, 15s timeout per name                                                                        |
| 3   | Delegated HTTP IPNS resolve | Partial — ipns-helpers.ts supports it, but relay.ts has no delegatedRouting configured so pinner always falls back to DHT |
| 4   | State validation (P0 crash) | Done — validateState() handles {}, missing knownNames, bad tips                                                           |
| 5   | catch{} fixes               | Partial — diagnostics + topology-sharing fixed, but snapshot-watcher.ts:237,414 and index.ts:843,987,1005 still silent    |
| 6   | relay.ts + http.ts tests    | Done — relay.test.ts (caps encode/decode, appIdToCID), http.test.ts (all endpoints)                                       |
| 7   | Editor.tsx doc.destroy      | Done — last-declared useEffect, correct cleanup order                                                                     |
| 8   | Topology jitter             | Done — fingerprint + incremental d3 update, no full restart                                                               |
| 9   | Docs update                 | Partial — guide.md + core README current, architecture.md still uses "subdocument"                                        |
| 10  | Server drain                | Done — bin/node.ts calls closeAllConnections()                                                                            |
| 11  | getHelia export             | Not started — still exported at index.ts:1316                                                                             |

### Wave 1 New Issues

- **Delegated routing not configured in relay.ts** (lines
  203-283). The pinner's resolveIPNS always falls to DHT,
  emitting a warn log on every invocation. Needs
  delegatedRouting service in Helia config.

- **state.test.ts missing crash case.** Only 2 tests.
  The P0 case ({} empty object) is not tested. Also
  missing: invalid JSON, missing knownNames, non-array
  knownNames, missing tips, partial state.

- **http.test.ts mock mesh is structurally shallow.**
  `pubsub.mesh` is an empty Map, so gossipsub mesh
  count tests don't verify real data. Also: afterEach
  only calls server.close(), not closeAllConnections().

- **snapshot-watcher.ts catch blocks** (lines 237-239,
  414-416) swallow errors silently in the retry path.
  Should log the error before scheduling retry.

- **TopologyMap graphFp** doesn't include label field.
  Label changes (from new caps messages) won't trigger
  re-render until the 8s debounce fires.

---

## Post-Wave-1 Fixes

### Guarantee-Query Protocol

| Area                                           | Correct     | Tested                                          |
| ---------------------------------------------- | ----------- | ----------------------------------------------- |
| 3s initial delay (readers)                     | Yes         | Yes                                             |
| 3s initial delay (writers via startReannounce) | Yes         | Yes                                             |
| Event-driven query on pinner discovery         | Yes         | **No** — nodeChangeHandler in index.ts untested |
| 5-min re-query interval                        | Yes         | Yes                                             |
| trackCidForAcks on snapshot apply              | Yes         | Yes (indirect)                                  |
| trackCidForAcks on publish()                   | Yes         | **No**                                          |
| onAck fires on any guarantee change            | Intentional | **No**                                          |

**Findings:**

- The 3s mesh delay is defensible. GossipSub GRAFT takes
  1-2 heartbeats (~1-2s). 3s is conservative on fast
  connections; on slow mobile it may not be enough but
  the 5-min re-query and event-driven paths provide
  backstops.

- `onAck` event now has dual meaning: CID match (from
  ack messages) and any guarantee change (from
  guarantee-response). This causes harmless extra
  re-renders in Editor.tsx when guarantee state changes
  but ackedBy.size hasn't changed. Worth documenting.

- `initialQueryTimer` reuse between reader/writer paths
  is safe (guarded by announceTimer check in
  startReannounce) but the coupling is implicit.

### Topology + UI

| Area                         | Status |
| ---------------------------- | ------ |
| Organic layout / infra spine | Done   |
| Browser node style (filled)  | Done   |
| Particles only on self-edges | Done   |
| Bottom panel always visible  | Done   |
| Guarantee UX labels          | Done   |
| Guarantee halos immediate    | Done   |

**Finding:** Browser nodes have very weak center force
(0.03 vs 0.12 for infra). On sparse graphs with no
infra links, browsers could drift past the viewBox
clamp boundary. Cosmetic only.

---

## CI / Tooling

### GitHub Actions

| Item                            | Status | Issue?                                                            |
| ------------------------------- | ------ | ----------------------------------------------------------------- |
| Build → test → lint → format    | Done   | —                                                                 |
| continue-on-error removed       | Done   | —                                                                 |
| Node 22, npm cache, concurrency | Done   | —                                                                 |
| Deploy depends on CI            | —      | **No** — deploy.yml has no `needs: ci`, broken commits can deploy |
| Node version consistency        | —      | **CI=22, deploy=20** — should align                               |
| Separate type-check step        | —      | Not present, tsc --build conflates build + typecheck              |

### Husky + lint-staged

| Item                  | Status | Issue?                                          |
| --------------------- | ------ | ----------------------------------------------- |
| .husky/pre-commit     | Done   | —                                               |
| lint-staged config    | Done   | prettier → eslint order correct                 |
| eslint --max-warnings | —      | Not set — warnings pass silently at commit time |

### ESLint

| Item                               | Status  | Issue?                                                                                                             |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Test file no-explicit-any override | Done    | —                                                                                                                  |
| All source errors fixed            | Done    | 0 errors                                                                                                           |
| File-level disables                | 4 files | index.ts, peer-discovery.ts, node-registry.ts, relay.ts — blanket suppressions risk hiding future type regressions |

### Other Tooling

| Item                        | Status                                    |
| --------------------------- | ----------------------------------------- |
| Vitest workspace → projects | Done                                      |
| Silent log level            | Done                                      |
| .prettierrc config          | Done (singleQuote implicit, not explicit) |

---

## Browser → Pinner HTTP Connections

### Recommendation: Pursue HTTP block endpoint only

The large-block problem (docs >256KB) is a **real silent
failure today**. Bitswap browser↔relay is broken (unknown
root cause). HTTP GET /block/:cid is the correct fix.

**Do not pursue** HTTP for guarantee queries, health
checks, or initial fetch optimization — GossipSub
already handles these adequately.

### Implementation Order

1. `GET /block/:cid` on relay HTTP server + per-IP rate
   limiting + **CORS headers** (critical gap in existing
   plan). Self-contained in packages/node.

2. `httpUrl` in caps advertisements. Relay + core
   node-registry change. Non-breaking — just adds a field.

3. HTTP fallback in fetch-block.ts, threaded through
   snapshot-lifecycle. Pure core change.

### Critical Gaps in Existing Plan

- **CORS not mentioned.** Browser fetch from
  `https://app.example` to `https://relay.example:3000`
  requires `Access-Control-Allow-Origin` headers.
  Without this, browser fetch silently fails.

- **Mixed content.** HTTP server is plain `createServer()`
  (no TLS). Browsers on HTTPS will block plain HTTP
  requests. Requires HTTPS reverse proxy (nginx) in
  front. `httpUrl` in caps must be `https://` only.

- **Not a breaking change.** Old relays 404 on new
  endpoint; browsers fall back to existing retry.
  Fully backward compatible.

---

## Prioritized Action Items

### P0 (correctness)

1. **Deploy depends on CI** — deploy.yml should require
   CI passes (add `needs:` or use `workflow_run`)
2. **Delegated routing for pinner** — configure in
   relay.ts so IPNS resolve uses HTTP not just DHT

### P1 (test gaps)

3. **nodeChangeHandler pinner-discovery test** — the
   event-driven guarantee query path has no test
4. **state.test.ts coverage** — add crash case ({}),
   invalid JSON, partial state tests
5. **trackCidForAcks on publish() test** — verify
   ackedBy clears immediately

### P2 (code quality)

6. **snapshot-watcher.ts silent catches** — add log.warn
   before scheduleRetry at lines 237, 414
7. **Remaining silent catches** in index.ts (lines
   843, 987, 1005) — add log.warn or log.debug
8. **getHelia export removal** — remove from public API
9. **File-level eslint-disable** — replace with targeted
   per-line disables over time
10. **Node version alignment** — CI and deploy both on 22
11. **architecture.md terminology** — "subdocument" → use
    "channel" in public-facing sections

### P3 (future work)

12. **HTTP block endpoint** — pursue per plan above,
    adding CORS + mixed-content handling
13. **index.ts further decomposition** — still 1326 lines
14. **http.test.ts mock mesh** — fix to test real mesh
    count path

---

## Load Test Context

1000-doc test results: 487% ack rate, p50=4s, 100%
guarantee coverage, 0 errors. System is healthy at
current scale. The parallel IPNS republish (Wave 1)
raises theoretical capacity from ~2,400 to ~12,000
docs/pinner.
