# Reader Peers for Load Testing (#171)

## Problem

The load-test CLI parses `--readers N` but doesn't
implement reader peers. Without readers, we can only
measure write throughput and pinner ack latency — not
end-to-end sync latency or CRDT convergence under
load.

## Approach

Standalone `src/reader-peer.ts` module. Receives
GossipSub announcements with inline blocks, decodes
and decrypts snapshots, applies Yjs state, verifies
convergence via clockSum comparison.

Rejected alternatives:

- **Core Doc.open()**: browser-like env dependency,
  tests core sync rather than load characteristics
- **Extend existing reader.ts**: conflates GossipSub
  observer (smoke test) with active document reader

## Design

### Writer changes

Writers expose `readKey` and `ipnsName` after
creation so reader peers can decrypt their snapshots.

```typescript
export interface Writer {
  readonly ipnsName: string;
  readonly writerId: string;
  readonly readKey: CryptoKey; // NEW
  stop(): void;
}
```

### Reader peer module (`src/reader-peer.ts`)

Each reader peer:

1. Subscribes to the announce topic
2. Maintains a `Map<ipnsName, Y.Doc>` for tracked
   writers
3. On non-ack announcement with inline block:
   - Base64-decode the block
   - `decodeSnapshot()` to get SnapshotNode
   - `decryptSnapshot()` with writer's readKey
   - Apply Yjs update to local doc
   - Compare `doc.getText("content").length` with
     announced clockSum
4. Records sync latency (announcement receive time
   minus announcement timestamp, if available, or
   just records the receive time for external
   correlation)

```typescript
export interface ReaderPeerConfig {
  appId: string;
  writers: ReadonlyMap<string, CryptoKey>;
  onEvent?: (event: ReaderPeerEvent) => void;
}

export interface ReaderPeer {
  readonly peerId: string;
  readonly syncedDocs: ReadonlySet<string>;
  readonly convergenceErrors: number;
  stop(): void;
}

export interface ReaderPeerEvent {
  type: "reader-synced" | "convergence-ok" | "convergence-drift" | "error";
  peerId: string;
  timestampMs: number;
  ipnsName?: string;
  cid?: string;
  latencyMs?: number;
  expectedClockSum?: number;
  actualClockSum?: number;
  error?: string;
}
```

### Convergence check

Compare `text.length` (reader's Y.Doc) against the
announced `clockSum` (writer's `text.length` at
announce time). This is a lightweight proxy — full
Yjs state vector comparison is out of scope (covered
by unit tests). Drift indicates lost or delayed
announcements.

### CLI wiring (`bin/run.ts`)

After writers are spawned:

1. Collect `Map<ipnsName, readKey>` from writers
2. Create a second shared Helia node for readers
3. Spawn N reader peers, each tracking all writer docs
4. On shutdown, stop readers before stopping nodes

### Metrics events

New JSONL event types consumed by `bin/analyze.ts`:

- `reader-synced`: reader applied a snapshot
  (includes latencyMs, ipnsName, cid)
- `convergence-ok`: clockSum matches after apply
- `convergence-drift`: clockSum mismatch (includes
  expected vs actual)

### Helia topology

- Writers share one Helia node (existing)
- Readers share a second Helia node (new)
- Both nodes connect to same bootstrap peers
- Reader node dials writer node directly for
  GossipSub mesh (same pattern as smoke test)

### Resource budget

Two Helia nodes + GossipSub + Y.Docs should stay
within 200MB RSS budget. If not, collapse to one
shared node as fallback.

## Success criteria

- `--readers N` spawns N reader peers that track
  all writer docs
- Reader peers decode, decrypt, and apply snapshots
- clockSum convergence verified per announcement
- Sync latency recorded in JSONL
- Smoke test still passes (existing reader.ts
  unchanged)
- RSS stays under 200MB budget
