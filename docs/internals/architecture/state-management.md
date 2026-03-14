# State Management

All document state in `@pokapali/core` is driven by a
fact-stream architecture: an append-only log of typed
events, processed by pure reducers, with side effects
dispatched by a single interpreter loop.

```
events ──→ facts ──→ scan(reduce) ──→ interpreter
  ↑           ↑          │                │
  │           │          ▼                │
  │           │      DocState ──→ Feed<T> │
  │           │                           │
  │           └───── feedback facts ──────┘
  │
  GossipSub, IPNS, WebRTC, timers
```

---

## Facts

A **fact** is an immutable record of something that
happened. Facts are the only input to state. There are
27 fact types, grouped by domain:

| Group             | Facts                                                                                      | Triggered by                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Chain discovery   | `cid-discovered`, `block-fetch-started`, `block-fetched`, `block-fetch-failed`             | GossipSub announcements, IPNS resolve, chain walk, pinner index |
| Tip lifecycle     | `tip-advanced`, `announced`                                                                | Interpreter after applying a snapshot or announcing             |
| Per-CID metadata  | `ack-received`, `guarantee-received`                                                       | Pinner acks and guarantee responses                             |
| Gossip            | `gossip-message`, `gossip-subscribed`                                                      | GossipSub message handler                                       |
| Connectivity      | `sync-status-changed`, `awareness-status-changed`, `relay-connected`, `relay-disconnected` | WebRTC, awareness room, libp2p                                  |
| Persistence       | `content-dirty`, `publish-started`, `publish-succeeded`, `publish-failed`                  | Yjs subdoc changes, publish()                                   |
| Discovery         | `pinner-discovered`, `node-change`                                                         | Node caps, acks                                                 |
| Guarantee queries | `guarantee-query-sent`, `guarantee-query-responded`                                        | Guarantee protocol                                              |
| IPNS              | `ipns-resolve-started`, `ipns-resolve-completed`                                           | IPNS polling                                                    |
| Timers            | `reannounce-tick`, `tick`                                                                  | Periodic timers                                                 |

Facts are defined as a discriminated union in
`facts.ts`. Every fact carries a `type` and `ts`
(timestamp). Some carry payload (CIDs, peer IDs,
blocks).

**Key property:** facts are additive. The system never
deletes or modifies a fact — it pushes new facts that
supersede old state. For example, `tip-advanced`
doesn't delete the old tip; it records a new tip, and
the reducer updates `chain.tip` accordingly.

---

## State

`DocState` is the complete state of a document at any
point in time. It's a plain object — no classes, no
methods, no mutability.

```ts
interface DocState {
  identity: {
    ipnsName: string;
    role: DocRole;
    channels: string[];
    appId: string;
  };
  chain: ChainState;
  connectivity: Connectivity;
  content: ContentState;
  announce: AnnounceState;
  pendingQueries: ReadonlyMap<string, { sentAt: number }>;
  ipnsStatus: IpnsResolutionStatus;
  status: DocStatus; // derived
  saveState: SaveState; // derived
}
```

### ChainState

Tracks every CID the system has encountered and their
relationships:

```ts
interface ChainState {
  entries: ReadonlyMap<string, ChainEntry>;
  tip: CID | null;
  applying: CID | null;
  newestFetched: CID | null;
  maxSeq: number; // O(1) via reducer tracking
}

interface ChainEntry {
  cid: CID;
  seq?: number;
  ts?: number;
  discoveredVia: ReadonlySet<CidSource>;
  blockStatus: "unknown" | "fetching" | "fetched" | "applied" | "failed";
  fetchAttempt: number;
  fetchStartedAt?: number;
  lastError?: string;
  prev?: CID;
  guarantees: ReadonlyMap<
    string,
    { guaranteeUntil: number; retainUntil: number }
  >;
  ackedBy: ReadonlySet<string>;
}
```

**CID sources:** `"gossipsub"`, `"ipns"`,
`"reannounce"`, `"chain-walk"`, `"pinner-index"`.
A single CID can be discovered via multiple sources;
`discoveredVia` tracks all of them.

### Connectivity

```ts
interface Connectivity {
  syncStatus: SyncStatus;
  awarenessConnected: boolean;
  gossip: GossipState;
  relayPeers: ReadonlySet<string>;
  knownPinnerPids: ReadonlySet<string>;
}
```

### Derived fields

`status` and `saveState` are computed by the reducer
from connectivity and content state respectively —
they're in `DocState` for convenience but are not
independently stored.

---

## Reducers

Pure functions in `reducers.ts`. Given the current
`DocState` and a `Fact`, return the next `DocState`.
No side effects. No I/O.

```ts
function reduce(state: DocState, fact: Fact): DocState;
```

Internally decomposed into domain reducers:

| Reducer              | Handles                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `reduceChain`        | cid-discovered, block-fetched, tip-advanced, ack-received, guarantee-received, etc. |
| `reduceGossip`       | gossip-message, gossip-subscribed, tick                                             |
| `reduceConnectivity` | sync-status-changed, awareness-status-changed, relay-connected/disconnected         |
| `reduceContent`      | content-dirty, publish-started/succeeded/failed                                     |
| `reduceAnnounce`     | announced, reannounce-tick, guarantee-query-sent/responded                          |

After reducing, `deriveStatus()` and `deriveSaveState()`
recompute the derived fields.

### Status derivation

```
1. Any channel WebRTC connected → "synced"
2. Channel providers connecting  → "connecting"
3. Awareness room connected OR
   GossipSub message within 60s → "receiving"
4. Subscribed, no recent gossip  → "connecting"
5. Otherwise                     → "offline"
```

The 60-second gossip recency window uses an exact
wake-up timer (the interpreter schedules a `tick` fact
at `lastMessageAt + 60s`), not a polling interval.

### SaveState derivation

```
publish in progress          → "saving"
local changes since snapshot → "dirty"
no snapshot ever published   → "unpublished"
otherwise                    → "saved"
```

---

## Scan Pipeline

`scan()` in `sources.ts` is the core loop. It
consumes an async iterable of facts, applies the
reducer to each, and yields `{ prev, next, fact }`
triples:

```ts
async function* scan(
  facts: AsyncIterable<Fact>,
  reduce: (state: DocState, fact: Fact) => DocState,
  init: DocState,
): AsyncIterable<{ prev: DocState; next: DocState; fact: Fact }>
```

The scan output drives both the interpreter (for side
effects) and Feed projections (for consumers).

**Fact sources** are merged into a single async
iterable via `merge()`:

- **GossipSub bridge** — converts pubsub messages to
  `cid-discovered`, `ack-received`,
  `guarantee-received`, `gossip-message` facts
- **IPNS polling** — emits `ipns-resolve-started`,
  `ipns-resolve-completed`, `cid-discovered`
- **WebRTC/awareness callbacks** — emit
  `sync-status-changed`, `awareness-status-changed`
- **Timers** — emit `reannounce-tick`, `tick`
- **Interpreter feedback** — pushes `block-fetched`,
  `tip-advanced`, `announced`, etc.

All sources push into a shared `AsyncQueue<Fact>`.
The queue is the single entry point for all state
changes.

---

## Interpreter

`runInterpreter()` in `interpreter.ts` is the **only
impure code** in the state management system. It
consumes the scan output stream and dispatches side
effects based on state transitions.

```ts
async function runInterpreter(
  stream: AsyncIterable<{
    prev: DocState;
    next: DocState;
    fact: Fact;
  }>,
  effects: EffectHandlers,
  feedback: AsyncQueue<Fact>,
  signal: AbortSignal,
): Promise<void>;
```

### What the interpreter does

For each `{ prev, next, fact }` triple:

1. **Auto-fetch:** If a new CID appears with
   `blockStatus: "unknown"` and passes the fetch
   policy (`shouldAutoFetch`), dispatch
   `effects.fetchBlock(cid)`. Push `block-fetched` or
   `block-fetch-failed` as feedback.

2. **Apply snapshot:** When a block is fetched and
   seq ≥ current tip's seq, call
   `effects.applySnapshot(cid, block)`. Push
   `tip-advanced` on success.

3. **Chain walk:** After applying a snapshot with a
   `prev` link, push `cid-discovered` for the
   predecessor (source: `"chain-walk"`).

4. **Announce:** After `tip-advanced` or on
   `reannounce-tick`, call
   `effects.announce(cid, block, seq)`.

5. **Wake-up scheduling:** Schedule `tick` facts for
   future state transitions (gossip decay at exactly
   `lastMessageAt + 60s`, guarantee query retries).

6. **Emit events:** Call `effects.emitSnapshotApplied`,
   `effects.emitAck`, `effects.emitGossipActivity`,
   etc. to notify consumers.

### EffectHandlers

Dependency injection for all side effects. In
production (`create-doc.ts`), these connect to real
implementations:

```ts
interface EffectHandlers {
  fetchBlock(cid: CID): Promise<Uint8Array | null>;
  applySnapshot(cid: CID, block: Uint8Array): Promise<{ seq: number }>;
  getBlock(cid: CID): Uint8Array | null;
  decodeBlock(block: Uint8Array): { prev?: CID; seq?: number };
  announce(cid: CID, block: Uint8Array, seq: number): void;
  markReady(): void;
  emitSnapshotApplied(cid: CID, seq: number): void;
  emitAck(cid: CID, ackedBy: ReadonlySet<string>): void;
  emitGossipActivity(activity: GossipActivity): void;
  emitLoading(phase: string): void;
  emitGuarantee(
    cid: CID,
    guarantees: ReadonlyMap<
      string,
      { guaranteeUntil: number; retainUntil: number }
    >,
  ): void;
  emitStatus(status: DocStatus): void;
  emitSaveState(saveState: SaveState): void;
}
```

In tests, handlers are replaced with stubs — this is
the primary testability benefit of the architecture.

### Fetch policy

`shouldAutoFetch(entry, state)` determines whether to
fetch a CID:

- Skip if already fetching, fetched, applied, or
  failed at max attempts
- Skip if another CID is currently being applied
- Prefer higher-seq CIDs over lower ones
- Fetch chain-walk predecessors only after the tip
  is applied

### Retry model

Block fetches that fail are retried when the CID is
re-discovered (via GossipSub re-announce at 15s
intervals, or IPNS polling at 30s). There is no
explicit retry loop with fixed intervals — retry is
event-driven.

---

## Feed Projections

A `Feed<T>` is a reactive value container that
projects a slice of `DocState` for consumers. It's
designed for direct use with React's
`useSyncExternalStore`.

```ts
interface Feed<T> {
  getSnapshot(): T;
  subscribe(cb: () => void): () => void;
}
```

`createFeed<T>(initial, eq?)` creates a Feed with an
optional equality function (defaults to `===`). The
internal `_update(value)` method is a no-op when the
new value equals the current one, preventing spurious
notifications.

### Doc Feeds

| Feed                | Type                        | Changes when                                         |
| ------------------- | --------------------------- | ---------------------------------------------------- |
| `doc.statusFeed`    | `Feed<DocStatus>`           | WebRTC connects/disconnects, gossip activity changes |
| `doc.saveStateFeed` | `Feed<SaveState>`           | Content dirtied, publish starts/completes            |
| `doc.tipFeed`       | `Feed<VersionInfo \| null>` | New snapshot applied (local or remote)               |
| `doc.loadingFeed`   | `Feed<LoadingState>`        | IPNS resolving, block fetching, retry, failure       |

**Why separate Feeds:** `gossip-message` facts fire
on every GossipSub message (including awareness
updates, multiple per second with active
collaborators). A monolithic `Feed<DocState>` would
re-render the entire UI on every awareness update.
Separate Feeds with equality gates ensure only the
relevant slice triggers notifications.

### Update paths

- `statusFeed` and `saveStateFeed` are updated
  synchronously in `checkStatus()`/`checkSaveState()`
  — these need exact timing relative to event
  emitters
- `tipFeed` and `loadingFeed` are updated in the
  scan `captureState` loop — they derive from
  interpreter state

### React integration

```tsx
import { useSyncExternalStore } from "react";

function StatusIndicator({ doc }) {
  const status = useSyncExternalStore(
    doc.statusFeed.subscribe,
    doc.statusFeed.getSnapshot,
  );
  return <span>{status}</span>;
}
```

No wrapper hook needed — `Feed<T>` matches
`useSyncExternalStore`'s contract exactly.

---

## Loading State Machine

`doc.loadingFeed` reports the snapshot fetch lifecycle:

```
  ┌──────────────────────────────────────────┐
  │                                          │
  ▼                                          │
idle ──→ resolving ──→ fetching ──→ idle     │
                          │                  │
                          ▼                  │
                       retrying ─────────────┘
                          │
                          ▼
                       failed
```

| State       | Fields                          | Entered when                                       |
| ----------- | ------------------------------- | -------------------------------------------------- |
| `idle`      | —                               | Snapshot applied, or new doc with no remote state  |
| `resolving` | `startedAt`                     | IPNS poll begins (readers on `open()`)             |
| `fetching`  | `cid`, `startedAt`              | CID received from announcement or IPNS resolve     |
| `retrying`  | `cid`, `attempt`, `nextRetryAt` | Block fetch failed; re-triggered on next discovery |
| `failed`    | `cid`, `error`                  | Fetch exhausted (no more discovery events)         |

Writers skip `resolving` — they receive snapshots via
GossipSub announcements, which provide the CID
directly. Readers start with IPNS resolution.

Retries are event-driven: a failed fetch is retried
when the CID is re-discovered via GossipSub
re-announce (15s) or IPNS poll (30s). There is no
fixed retry count or interval.

On `failed`, the library calls `markReady()` so the
editor mounts with whatever state is available rather
than blocking forever.

---

## Wiring in create-doc.ts

`createDoc()` assembles the full pipeline:

1. Creates an `AsyncQueue<Fact>` as the shared fact
   entry point
2. Sets up fact sources: GossipSub bridge, IPNS
   polling, WebRTC/awareness callbacks, timers
3. Creates the scan pipeline:
   `scan(factQueue, reduce, initialState)`
4. Wraps the scan in `captureState()` which updates
   `tipFeed` and `loadingFeed` on each step
5. Runs `runInterpreter(captureState(scan), effects,
factQueue, signal)` with real effect handlers
6. Creates `statusFeed` and `saveStateFeed` updated
   synchronously from local tracking

### Hybrid status/saveState

`status` and `saveState` are computed locally
(synchronous) rather than read from the interpreter's
async `DocState`. This preserves exact timing — the
`"status"` event fires in the same microtask as the
underlying transport change, not after the async scan
pipeline processes it. The interpreter also tracks
these internally for its own logic, but the local
values are authoritative for getters and events.

### Teardown

On `doc.destroy()`:

1. Abort the interpreter's `AbortController`
2. Clear timers (IPNS poll, reannounce, guarantee
   query)
3. Unsubscribe from GossipSub topic
4. Remove event listeners
5. Clean up WebRTC providers, awareness room

---

## Testing

The architecture is designed for testability at
every layer:

- **Reducers** — pure functions, tested with
  property-based tests (59 tests). Given a state and
  fact, assert the output state.
- **Sources** — async generators, tested with
  controlled queues (22 tests).
- **Interpreter** — tested with stub effect handlers
  (40 tests). Push facts, assert which effects were
  called.
- **Facts** — type coverage and initial state tests
  (14 tests).

Total: 135 tests for the state management layer,
all deterministic (no network, no timers, no I/O).
