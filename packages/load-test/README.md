# @pokapali/load-test

Private package for load testing, chaos testing, and
reliability validation of the pokapali network. Not
published to npm.

## Why

The main `@pokapali/core` export depends on y-webrtc,
which crashes in Node.js. This package bypasses that by
importing internal modules directly (announce, snapshot,
crypto, subdocs), enabling headless Node.js load tests
against real relay infrastructure.

## Prerequisites

- Node.js >= 22
- Build the monorepo: `npm run build` from repo root
- For remote tests: SSH access to the test VPS

## CLI Tools

Build first: `npm run build -w packages/load-test`

### `pokapali-load-test` (bin/run.ts)

Main load test harness. Spawns writers that create
docs, push snapshots via GossipSub, and track pinner
acks. Optionally spawns readers that verify convergence.

```
node dist/bin/run.js [options]

Options:
  --docs N          Number of documents (default: 1)
  --readers N       Reader peers (default: 0)
  --duration S      Test duration in seconds (default: 60)
  --interval MS     Edit interval in ms (default: 5000)
  --edit-size BYTES Bytes per edit (default: 100)
  --bootstrap ADDR  Relay multiaddr (repeatable)
  --http-url URL    HTTPS block endpoint (repeatable)
  --output PATH     JSONL output file (default: stdout)
  --ramp            Stagger doc creation over duration
  --app-id ID       GossipSub app ID
                    (default: "pokapali-example")
  --log-level LEVEL Log verbosity
```

Example (50 writers, 5 readers, 5 minutes):

```sh
node dist/bin/run.js \
  --docs 50 --readers 5 --duration 300 \
  --bootstrap /ip4/127.0.0.1/tcp/4001 \
  --output results.jsonl
```

### `pokapali-load-smoke` (bin/smoke.ts)

CI smoke test. Starts an ephemeral relay, runs 5
writers and 1 reader for 30 seconds, then checks:

- Reader received announcements from all 5 docs
- Zero errors
- Peak RSS < 200 MB

```
node dist/bin/smoke.js [--output PATH] [--log-level LEVEL]
```

Exit 0 = pass, exit 1 = fail.

### `pokapali-load-churn` (bin/churn.ts)

Peer churn simulation. Uses the ChurnScheduler to
add and remove writers/readers at configurable
intervals.

```
node dist/bin/churn.js [options]

Options:
  --writers N          Baseline writer count (default: 3)
  --readers N          Baseline reader count (default: 2)
  --churn-interval MS  Cycle interval (default: 30000)
  --churn-size N       Nodes removed per cycle (default: 1)
  --stabilize MS       Delay between remove and replace
                       (default: 5000)
  --duration S         Total duration (default: 120)
  --bootstrap ADDR     Relay multiaddr (repeatable)
  --http-url URL       Block endpoint (repeatable)
  --output PATH        JSONL output file
  --app-id ID          GossipSub app ID
  --log-level LEVEL    Log verbosity
```

### `pokapali-load-analyze` (bin/analyze.ts)

Reads JSONL output and produces a pass/fail verdict.
Used by CI to gate on load test results.

```
node dist/bin/analyze.js <file.jsonl> [options]

Options:
  --ack-rate PCT       Min ack rate (default: 95)
  --latency-p95 MS     Max ack p95 latency (default: 5000)
  --max-errors N       Max errors allowed (default: 0)
  --max-rss MB         Max peak RSS (default: 200)
  --recovery MS        Max mesh recovery time
                       (default: 30000)
  --cross-region       Use 10s latency threshold
  --phase NAME:S:S     Define analysis window
                       (name:startS:endS)
  --phase-ack-rate N:P Min ack rate for a phase
                       (name:minPct)
```

Exit 0 = pass, exit 1 = fail, exit 2 = usage error.

## Chaos Tests

Shell scripts for fault injection scenarios, run
weekly via GitHub Actions (`chaos-weekly.yml`).

### `bin/chaos-fleet.sh`

Manages ephemeral relay fleets on the test VPS.

```
chaos-fleet.sh start <count> [--base-port N]
  [--base-tcp-port N] [--pin-count N] [--app-id ID]
chaos-fleet.sh stop
chaos-fleet.sh health
chaos-fleet.sh pids
chaos-fleet.sh bootstrap
```

### `bin/chaos-s1.sh` — Relay Kill

Kills 1 of 4 relays mid-session and measures
degraded ack rate. Validates GossipSub mesh recovery.

```
chaos-s1.sh [--output DIR] [--baseline S]
  [--degraded S] [--writers N] [--readers N]
```

### `bin/chaos-s4.sh` — Peer Churn

Rapid peer join/leave stress test. Runs baseline,
churn, and recovery phases with per-phase thresholds.

```
chaos-s4.sh [--output DIR] [--baseline S]
  [--churn S] [--recovery S] [--writers N]
```

## Output Format

All tools emit newline-delimited JSON (JSONL) with
event types:

- `doc-created` — new doc started
- `snapshot-pushed` — snapshot encoded and announced
- `ack-received` — pinner acknowledgment received
- `reader-synced` — reader applied a snapshot
- `convergence-ok` / `convergence-drift` — hash check
- `node-joined` / `node-left` — churn events
- `churn-cycle` — churn scheduler tick
- `status-change` — connectivity change
- `error` — unexpected failure

## Source Layout

```
bin/
  run.ts          Main load test CLI
  smoke.ts        CI smoke test
  churn.ts        Churn simulation CLI
  analyze.ts      JSONL analyzer
  analyze.test.ts Analyzer tests
  chaos-fleet.sh  Relay fleet management
  chaos-s1.sh     S1: relay kill scenario
  chaos-s4.sh     S4: peer churn scenario
src/
  helia-node.ts   Node.js Helia setup (ephemeral)
  writer.ts       Simulated doc writer
  reader-peer.ts  GossipSub reader peer
  reader.ts       Announcement reader (smoke)
  churn.ts        ChurnScheduler orchestration
  metrics.ts      JSONL event logger
  index.ts        Re-exports
```

## CI Integration

- **Nightly** (`load-nightly.yml`): 50 docs, 5
  readers, 300s on test VPS ephemeral relay
- **Weekly chaos** (`chaos-weekly.yml`): S1 + S4
  scenarios on 4-relay fleet
- **Smoke** (unit test suite): runs via `npm test`
  in CI alongside other packages
