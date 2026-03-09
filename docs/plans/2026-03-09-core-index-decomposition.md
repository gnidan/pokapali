# core/index.ts Decomposition Plan

> **For Claude:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan
> task-by-task.

**Goal:** Split `packages/core/src/index.ts` (1308 lines)
into focused modules with clear boundaries, improving
testability and reducing merge conflict risk.

**Architecture:** Extract three modules from the
`createCollabDoc` closure: snapshot lifecycle management,
IPNS/announce coordination, and relay sharing. Keep the
`CollabDoc` interface and `createCollabLib` factory in
`index.ts` but thin them down to delegation. Each extracted
module is a plain function returning a destroyable handle
— no classes, no OOP beyond what's already there.

**Tech Stack:** TypeScript, Yjs, vitest, multiformats

---

## Background

### Current structure of `packages/core/src/`

```
index.ts          — 1308 lines (THE PROBLEM)
  createCollabDoc()   234-975  — document object factory
  createCollabLib()   977-1297 — create/open factory
ipns-helpers.ts   — publishIPNS, resolveIPNS, watchIPNS
peer-discovery.ts — relay DHT discovery + caching
announce.ts       — GossipSub snapshot announcements
helia.ts          — shared Helia singleton management
forwarding.ts     — document rotation forwarding records
```

### What lives in `createCollabDoc` today

1. **Snapshot chain state** (seq, prev, blocks Map)
2. **Snapshot lifecycle** (applySnapshotFromCID,
   pushSnapshot, fetchBlock, retry logic)
3. **IPNS/announce coordination** (subscribe to announce
   topic, handle announcements, re-announce timer, IPNS
   watch setup)
4. **Relay sharing** (awareness-based relay entry exchange
   with peer-discovery)
5. **Event system** (listeners Map, emit, on, off)
6. **Status tracking** (computeStatus, checkStatus)
7. **Document API surface** (subdoc, inviteUrl, history,
   loadVersion, rotate, destroy)

### What lives in `createCollabLib` today

1. **`create()`** — key generation, subdoc/sync/awareness
   setup, _meta population, URL building
2. **`open()`** — URL parsing, forwarding detection,
   same setup as create but from parsed keys, initial
   IPNS resolve (fire-and-forget)

### Decomposition targets

| New module | Extracts from | Responsibility |
|---|---|---|
| `snapshot-lifecycle.ts` | createCollabDoc lines 250-411, 597-674, 880-945 | Chain state (seq/prev/blocks), push, apply, fetch+retry, history, loadVersion |
| `snapshot-watcher.ts` | createCollabDoc lines 374-496, 331-366 | IPNS watch, announce subscribe/handle, re-announce timer |
| `relay-sharing.ts` | createCollabDoc lines 285-329 | Awareness-based relay entry exchange |

`index.ts` retains: `CollabDoc`/`CollabLib` interfaces,
`createCollabDoc` (thinned to ~200 lines of delegation),
`createCollabLib` (unchanged), event system, status
tracking, `computeStatus`, `fetchBlock`.

### Design constraints

- **No API changes.** The `CollabDoc` and `CollabLib`
  interfaces are the public surface. Nothing changes for
  consumers.
- **No new dependencies.** All extracted modules use types
  already imported by index.ts.
- **Event emission stays in index.ts.** The extracted
  modules call callbacks; index.ts maps those to the
  event system. This keeps the event system centralized
  and avoids passing the listeners Map around.
- **`fetchBlock` stays in index.ts.** It's a utility used
  by both snapshot-lifecycle and snapshot-watcher; keeping
  it in index.ts (or moving it to a tiny utils file)
  avoids circular deps.
- **Tests alongside modules.** Each new `.ts` file gets a
  corresponding `.test.ts` file. The existing
  `index.test.ts` stays and continues to test the
  integrated behavior.

---

## Task 1: Extract `fetchBlock` to its own module

`fetchBlock` is used by both snapshot-lifecycle and the
snapshot watcher. Extract it first so both can import it.

**Files:**
- Create: `packages/core/src/fetch-block.ts`
- Create: `packages/core/src/fetch-block.test.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Write the test for fetchBlock

```ts
// packages/core/src/fetch-block.test.ts
import { describe, it, expect, vi } from "vitest";
import { fetchBlock } from "./fetch-block.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

async function fakeCid(): Promise<CID> {
  const hash = await sha256.digest(
    new Uint8Array([1, 2, 3]),
  );
  return CID.createV1(0x71, hash);
}

describe("fetchBlock", () => {
  it("returns block on first try", async () => {
    const block = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid();
    const blockstore = {
      get: vi.fn().mockResolvedValue(block),
    };
    const result = await fetchBlock(
      { blockstore },
      cid,
    );
    expect(result).toBe(block);
    expect(blockstore.get).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure", async () => {
    const block = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid();
    const blockstore = {
      get: vi.fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue(block),
    };
    const result = await fetchBlock(
      { blockstore },
      cid,
      { retries: 2, baseMs: 1, timeoutMs: 5000 },
    );
    expect(result).toBe(block);
    expect(blockstore.get).toHaveBeenCalledTimes(2);
  });

  it(
    "throws after exhausting retries",
    async () => {
      const cid = await fakeCid();
      const blockstore = {
        get: vi.fn().mockRejectedValue(
          new Error("gone"),
        ),
      };
      await expect(
        fetchBlock(
          { blockstore },
          cid,
          { retries: 1, baseMs: 1, timeoutMs: 5000 },
        ),
      ).rejects.toThrow("gone");
    },
  );
});
```

### Step 2: Run the test — expect FAIL

Run: `cd packages/core && npx vitest run src/fetch-block.test.ts`
Expected: FAIL — module not found

### Step 3: Write `fetch-block.ts`

```ts
// packages/core/src/fetch-block.ts
import { CID } from "multiformats/cid";

const DEFAULT_RETRIES = 6;
const DEFAULT_BASE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchBlockOptions {
  retries?: number;
  baseMs?: number;
  timeoutMs?: number;
}

export interface BlockGetter {
  blockstore: {
    get(cid: CID, opts?: { signal?: AbortSignal }):
      Promise<Uint8Array> | Uint8Array;
  };
}

export async function fetchBlock(
  helia: BlockGetter,
  cid: CID,
  options?: FetchBlockOptions,
): Promise<Uint8Array> {
  const retries =
    options?.retries ?? DEFAULT_RETRIES;
  const baseMs =
    options?.baseMs ?? DEFAULT_BASE_MS;
  const timeoutMs =
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        timeoutMs,
      );
      try {
        const block: Uint8Array = await helia
          .blockstore.get(cid, {
            signal: ctrl.signal,
          });
        return block;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (i === retries) throw err;
      const delay = baseMs * 2 ** i;
      console.log(
        `[pokapali] block fetch retry` +
          ` ${i + 1}/${retries}` +
          ` in ${delay}ms for`,
        cid.toString().slice(0, 16) + "...",
      );
      await new Promise(
        (r) => setTimeout(r, delay),
      );
    }
  }
  throw new Error("unreachable");
}
```

### Step 4: Run the test — expect PASS

Run: `cd packages/core && npx vitest run src/fetch-block.test.ts`
Expected: PASS (3 tests)

### Step 5: Update index.ts to use fetchBlock from the new module

Replace the `fetchBlock` function and constants
(lines 171-210) with:

```ts
import {
  fetchBlock,
} from "./fetch-block.js";
```

Remove these lines from index.ts:
- `const FETCH_RETRIES = 6;` (line 171)
- `const FETCH_BASE_MS = 2_000;` (line 172)
- `const FETCH_TIMEOUT_MS = 15_000;` (line 173)
- The entire `async function fetchBlock(...)` (174-210)

### Step 6: Run full test suite — expect PASS

Run: `cd packages/core && npx vitest run`
Expected: All existing tests pass

### Step 7: Commit

```bash
git add packages/core/src/fetch-block.ts \
        packages/core/src/fetch-block.test.ts \
        packages/core/src/index.ts
git commit -m "refactor(core): extract fetchBlock to own module"
```

---

## Task 2: Extract `snapshot-lifecycle.ts`

This module owns the snapshot chain state and operations:
seq/prev tracking, the blocks cache, encoding+pushing
snapshots, applying snapshots from CIDs, walking history,
and loading historical versions.

**Files:**
- Create: `packages/core/src/snapshot-lifecycle.ts`
- Create: `packages/core/src/snapshot-lifecycle.test.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Write the test

```ts
// packages/core/src/snapshot-lifecycle.test.ts
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";

vi.mock("./fetch-block.js", () => ({
  fetchBlock: vi.fn(),
}));

import { createSnapshotLifecycle } from
  "./snapshot-lifecycle.js";
import { fetchBlock } from "./fetch-block.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
} from "@pokapali/snapshot";

vi.mock("@pokapali/snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("@pokapali/snapshot")
  >("@pokapali/snapshot");
  return {
    ...actual,
    encodeSnapshot: vi.fn(actual.encodeSnapshot),
    decodeSnapshot: vi.fn(actual.decodeSnapshot),
    decryptSnapshot: vi.fn(actual.decryptSnapshot),
  };
});

async function fakeCid(
  seed: number,
): Promise<CID> {
  const hash = await sha256.digest(
    new Uint8Array([seed]),
  );
  return CID.createV1(0x71, hash);
}

describe("createSnapshotLifecycle", () => {
  const mockHelia = {
    blockstore: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(
        new Error("Not found"),
      ),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("push increments seq and tracks prev", async () => {
    // Generate a real readKey for encryption
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const signingKey = {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    };

    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const plaintext = { content: new Uint8Array([1]) };
    const result1 = await lc.push(
      plaintext,
      readKey,
      signingKey,
      10,
    );
    expect(result1.seq).toBe(1);
    expect(result1.prev).toBeNull();

    const result2 = await lc.push(
      plaintext,
      readKey,
      signingKey,
      20,
    );
    expect(result2.seq).toBe(2);
    expect(result2.prev).not.toBeNull();
  });

  it("history returns empty before push", async () => {
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });
    const h = await lc.history();
    expect(h).toEqual([]);
  });

  it(
    "applyRemote updates seq/prev when remote is newer",
    async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );

      const lc = createSnapshotLifecycle({
        getHelia: () => mockHelia as any,
      });

      // Simulate a remote snapshot at seq=5
      const plaintext = { content: new Uint8Array([1]) };
      const block = await (
        encodeSnapshot as any
      ).getMockImplementation()(
        plaintext,
        readKey,
        null,
        5,
        Date.now(),
        {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      );

      const hash = await sha256.digest(block);
      const cid = CID.createV1(0x71, hash);

      vi.mocked(fetchBlock).mockResolvedValue(block);

      const applied: Record<string, Uint8Array>[] = [];
      const result = await lc.applyRemote(
        cid,
        readKey,
        (snap) => { applied.push(snap); },
      );

      expect(result).toBe(true); // applied
      expect(applied).toHaveLength(1);
    },
  );

  it(
    "applyRemote skips already-applied CID",
    async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const signingKey = {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64),
      };

      const lc = createSnapshotLifecycle({
        getHelia: () => mockHelia as any,
      });

      // Push a snapshot so we have a known CID
      const plaintext = { content: new Uint8Array([1]) };
      const { cid } = await lc.push(
        plaintext,
        readKey,
        signingKey,
        10,
      );

      // Applying the same CID should be a no-op
      const result = await lc.applyRemote(
        cid,
        readKey,
        () => {},
      );
      expect(result).toBe(false); // already applied
    },
  );
});
```

### Step 2: Run the test — expect FAIL

Run: `cd packages/core && npx vitest run src/snapshot-lifecycle.test.ts`
Expected: FAIL — module not found

### Step 3: Write `snapshot-lifecycle.ts`

```ts
// packages/core/src/snapshot-lifecycle.ts
import * as Y from "yjs";
import type { CID } from "multiformats/cid";
import {
  CID as CIDClass,
} from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  walkChain,
} from "@pokapali/snapshot";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { fetchBlock } from "./fetch-block.js";
import type { BlockGetter } from "./fetch-block.js";

const DAG_CBOR_CODE = 0x71;

export interface SnapshotLifecycleOptions {
  getHelia: () => BlockGetter;
}

export interface PushResult {
  cid: CID;
  seq: number;
  prev: CID | null;
  block: Uint8Array;
}

export interface SnapshotLifecycle {
  /**
   * Encode the current state as a snapshot, store it
   * in the block cache, and advance the chain pointer.
   * Returns the CID, seq, prev, and raw block.
   *
   * Does NOT publish IPNS or announce — the caller
   * handles that.
   */
  push(
    plaintext: Record<string, Uint8Array>,
    readKey: CryptoKey,
    signingKey: Ed25519KeyPair,
    clockSum: number,
  ): Promise<PushResult>;

  /**
   * Fetch and apply a remote snapshot by CID.
   * Returns true if applied, false if already applied.
   * Calls `onApply` with the decrypted plaintext so the
   * caller can feed it to subdocManager.applySnapshot.
   */
  applyRemote(
    cid: CID,
    readKey: CryptoKey,
    onApply: (
      plaintext: Record<string, Uint8Array>,
    ) => void,
  ): Promise<boolean>;

  /**
   * Walk the prev chain from the current tip.
   * Returns entries newest-first.
   */
  history(): Promise<
    Array<{ cid: CID; seq: number; ts: number }>
  >;

  /**
   * Load a historical version by CID. Returns a map
   * of namespace -> Y.Doc. Tries the block cache first,
   * then falls back to Helia blockstore.
   */
  loadVersion(
    cid: CID,
    readKey: CryptoKey,
  ): Promise<Record<string, Y.Doc>>;

  /** Get a cached block by CID string. */
  getBlock(cidStr: string): Uint8Array | undefined;

  /** Store a block in the cache. */
  putBlock(cidStr: string, block: Uint8Array): void;

  /** Current chain tip CID, or null. */
  readonly prev: CID | null;

  /** Current sequence number (next push will use this). */
  readonly seq: number;

  /** Last IPNS sequence number used. */
  readonly lastIpnsSeq: number | null;

  /** Update lastIpnsSeq after IPNS publish. */
  setLastIpnsSeq(seq: number): void;
}

export function createSnapshotLifecycle(
  options: SnapshotLifecycleOptions,
): SnapshotLifecycle {
  let seq = 1;
  let prev: CID | null = null;
  let lastIpnsSeq: number | null = null;
  const blocks = new Map<string, Uint8Array>();
  let lastAppliedCid: string | null = null;

  return {
    async push(
      plaintext,
      readKey,
      signingKey,
      clockSum,
    ): Promise<PushResult> {
      const prevForThis = prev;
      const seqForThis = seq;

      const block = await encodeSnapshot(
        plaintext,
        readKey,
        prevForThis,
        seqForThis,
        Date.now(),
        signingKey,
      );
      const hash = await sha256.digest(block);
      const cid = CIDClass.createV1(
        DAG_CBOR_CODE,
        hash,
      );

      const cidStr = cid.toString();
      blocks.set(cidStr, block);
      lastAppliedCid = cidStr;
      lastIpnsSeq = clockSum;

      prev = cid;
      seq++;

      return {
        cid,
        seq: seqForThis,
        prev: prevForThis,
        block,
      };
    },

    async applyRemote(
      cid,
      readKey,
      onApply,
    ): Promise<boolean> {
      const cidStr = cid.toString();
      if (cidStr === lastAppliedCid) return false;

      const helia = options.getHelia();
      const block = await fetchBlock(helia, cid);
      blocks.set(cidStr, block);

      const node = decodeSnapshot(block);
      const plaintext =
        await decryptSnapshot(node, readKey);

      onApply(plaintext);

      if (node.seq >= seq) {
        prev = cid;
        seq = node.seq + 1;
      }

      lastAppliedCid = cidStr;
      return true;
    },

    async history() {
      if (!prev) return [];

      const getter = async (cid: CID) => {
        const block = blocks.get(cid.toString());
        if (!block) {
          throw new Error(
            "Block not found: " +
              cid.toString(),
          );
        }
        return block;
      };

      const entries: Array<{
        cid: CID;
        seq: number;
        ts: number;
      }> = [];
      let currentCid: CID | null = prev;
      for await (const node of walkChain(
        prev,
        getter,
      )) {
        entries.push({
          cid: currentCid!,
          seq: node.seq,
          ts: node.ts,
        });
        currentCid = node.prev;
      }
      return entries;
    },

    async loadVersion(cid, readKey) {
      let block = blocks.get(cid.toString());
      if (!block) {
        try {
          const helia = options.getHelia();
          block =
            await helia.blockstore.get(cid);
        } catch {
          throw new Error(
            "Unknown CID: " + cid.toString(),
          );
        }
      }
      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(
        node,
        readKey,
      );
      const result: Record<string, Y.Doc> = {};
      for (const [ns, bytes] of Object.entries(
        plaintext,
      )) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        result[ns] = doc;
      }
      return result;
    },

    getBlock(cidStr) {
      return blocks.get(cidStr);
    },

    putBlock(cidStr, block) {
      blocks.set(cidStr, block);
    },

    get prev() {
      return prev;
    },

    get seq() {
      return seq;
    },

    get lastIpnsSeq() {
      return lastIpnsSeq;
    },

    setLastIpnsSeq(s: number) {
      lastIpnsSeq = s;
    },
  };
}
```

### Step 4: Run the test — expect PASS

Run: `cd packages/core && npx vitest run src/snapshot-lifecycle.test.ts`
Expected: PASS

Note: The test for `applyRemote` with a real
`encodeSnapshot` call is complex because it needs to
produce a valid encrypted block. If the mock setup is
too fragile, simplify: mock `decodeSnapshot` and
`decryptSnapshot` directly, and test that `applyRemote`
calls them with the fetched block. The important
behavior to test is CID deduplication and seq advancement.
Adjust the test accordingly during implementation.

### Step 5: Integrate into index.ts

In `createCollabDoc`, replace:
- The `seq`, `prev`, `lastIpnsSeq`, `blocks` variables
  (lines 251-254)
- The `applySnapshotFromCID` function (lines 389-411)
- The `pushSnapshot` method (lines 597-674)
- The `history` method (lines 880-912)
- The `loadVersion` method (lines 914-945)

With delegation to a `SnapshotLifecycle` instance:

```ts
const snapshotLC = createSnapshotLifecycle({
  getHelia: () => getHelia(),
});
```

Then in `pushSnapshot()`:
```ts
async pushSnapshot(): Promise<void> {
  assertNotDestroyed();
  if (
    !cap.canPushSnapshots ||
    !signingKey ||
    !readKey
  ) {
    return;
  }
  const plaintext = subdocManager.encodeAll();
  const clockSum = this.clockSum;
  const { cid, block } = await snapshotLC.push(
    plaintext,
    readKey,
    signingKey,
    clockSum,
  );

  checkStatus();
  emit("snapshot-applied");

  // Fire-and-forget IPNS publish + announce
  const cidShort = cid.toString().slice(0, 16);
  console.log(
    "[pokapali] pushSnapshot: cid=" +
      cidShort + "... clockSum=" + clockSum,
  );
  (async () => {
    const helia = getHelia();
    await Promise.resolve(
      helia.blockstore.put(cid, block),
    );
    await publishIPNS(
      helia, keys.ipnsKeyBytes!, cid, clockSum,
    );
    if (params.appId && params.pubsub) {
      await announceSnapshot(
        params.pubsub as any,
        params.appId,
        ipnsName,
        cid.toString(),
      );
    }
  })().catch((err: unknown) => {
    console.error(
      "[pokapali] IPNS publish/announce failed:",
      err,
    );
  });
},
```

Similarly delegate `history()`, `loadVersion()`, and
replace `applySnapshotFromCID` with a call to
`snapshotLC.applyRemote()`.

Replace references to `prev`, `seq`, `blocks`,
`lastIpnsSeq` with `snapshotLC.prev`, `snapshotLC.seq`,
`snapshotLC.getBlock(...)`, `snapshotLC.lastIpnsSeq`.

### Step 6: Run full test suite — expect PASS

Run: `cd packages/core && npx vitest run`
Expected: All tests pass (existing + new)

### Step 7: Commit

```bash
git add packages/core/src/snapshot-lifecycle.ts \
        packages/core/src/snapshot-lifecycle.test.ts \
        packages/core/src/index.ts
git commit -m "refactor(core): extract snapshot lifecycle to own module"
```

---

## Task 3: Extract `snapshot-watcher.ts`

This module handles receiving remote snapshots: listening
for GossipSub announcements, subscribing to the announce
topic, IPNS polling fallback, and retry scheduling.

**Files:**
- Create: `packages/core/src/snapshot-watcher.ts`
- Create: `packages/core/src/snapshot-watcher.test.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Write the test

```ts
// packages/core/src/snapshot-watcher.test.ts
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

vi.mock("./ipns-helpers.js", () => ({
  watchIPNS: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("./announce.js", () => ({
  announceTopic: vi.fn(
    (appId: string) =>
      `/pokapali/app/${appId}/announce`,
  ),
  parseAnnouncement: vi.fn().mockReturnValue(null),
  announceSnapshot:
    vi.fn().mockResolvedValue(undefined),
}));

import {
  createSnapshotWatcher,
} from "./snapshot-watcher.js";
import { watchIPNS } from "./ipns-helpers.js";
import {
  announceTopic,
  parseAnnouncement,
} from "./announce.js";

describe("createSnapshotWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to announce topic", () => {
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: false,
      onSnapshot: vi.fn(),
    });

    expect(pubsub.subscribe).toHaveBeenCalledWith(
      "/pokapali/app/test/announce",
    );

    watcher.destroy();
  });

  it("writers skip subscribe (already done)", () => {
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: true,
      onSnapshot: vi.fn(),
    });

    expect(pubsub.subscribe).not.toHaveBeenCalled();

    watcher.destroy();
  });

  it("starts IPNS polling", () => {
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: false,
      ipnsPublicKeyBytes: new Uint8Array(32),
      onSnapshot: vi.fn(),
    });

    expect(watchIPNS).toHaveBeenCalledTimes(1);

    watcher.destroy();
  });

  it("destroy cleans up", () => {
    const stopWatch = vi.fn();
    vi.mocked(watchIPNS).mockReturnValue(stopWatch);
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: false,
      ipnsPublicKeyBytes: new Uint8Array(32),
      onSnapshot: vi.fn(),
    });

    watcher.destroy();

    expect(stopWatch).toHaveBeenCalled();
    expect(
      pubsub.removeEventListener,
    ).toHaveBeenCalled();
  });
});
```

### Step 2: Run the test — expect FAIL

Run: `cd packages/core && npx vitest run src/snapshot-watcher.test.ts`
Expected: FAIL — module not found

### Step 3: Write `snapshot-watcher.ts`

```ts
// packages/core/src/snapshot-watcher.ts
import type { CID } from "multiformats/cid";
import { CID as CIDClass } from "multiformats/cid";
import type { PubSubLike } from "@pokapali/sync";
import {
  announceTopic,
  parseAnnouncement,
  announceSnapshot,
} from "./announce.js";
import type { AnnouncePubSub } from "./announce.js";
import { watchIPNS } from "./ipns-helpers.js";
import type { BlockGetter } from "./fetch-block.js";
import type { Helia } from "helia";

const REANNOUNCE_MS = 30_000;
const RETRY_INTERVAL_MS = 30_000;

export interface SnapshotWatcherOptions {
  appId: string;
  ipnsName: string;
  pubsub: PubSubLike;
  getHelia: () => Helia;
  /** True if this peer has write capability. */
  isWriter: boolean;
  /** Raw 32-byte Ed25519 public key for IPNS. */
  ipnsPublicKeyBytes?: Uint8Array;
  /**
   * Called when a new snapshot CID is received
   * (via announce or IPNS poll). The watcher
   * handles retry scheduling; the caller handles
   * applying the snapshot.
   */
  onSnapshot: (cid: CID) => Promise<void>;
}

export interface SnapshotWatcher {
  /**
   * Start periodic re-announce of the current
   * snapshot CID. Call after each push.
   */
  startReannounce(
    getCid: () => CID | null,
    getBlock: (
      cidStr: string,
    ) => Uint8Array | undefined,
  ): void;
  destroy(): void;
}

export function createSnapshotWatcher(
  options: SnapshotWatcherOptions,
): SnapshotWatcher {
  const {
    appId,
    ipnsName,
    pubsub,
    getHelia,
    isWriter,
    ipnsPublicKeyBytes,
    onSnapshot,
  } = options;

  let destroyed = false;
  const topic = announceTopic(appId);
  let pendingCid: string | null = null;
  let retryTimer: ReturnType<
    typeof setTimeout
  > | null = null;

  // --- Announce subscription ---

  // Writers already subscribe for re-announce mesh
  // in startReannounce; readers subscribe here.
  if (!isWriter) {
    pubsub.subscribe(topic);
  }

  function scheduleRetry() {
    if (retryTimer || !pendingCid) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (!pendingCid || destroyed) return;
      const cidStr = pendingCid;
      console.log(
        "[pokapali] retrying fetch for",
        cidStr.slice(0, 16) + "...",
      );
      try {
        await onSnapshot(CIDClass.parse(cidStr));
        pendingCid = null;
      } catch {
        scheduleRetry();
      }
    }, RETRY_INTERVAL_MS);
  }

  const announceHandler = (evt: CustomEvent) => {
    const { detail } = evt;
    if (detail?.topic !== topic) return;
    const ann = parseAnnouncement(detail.data);
    if (!ann || ann.ipnsName !== ipnsName) return;
    console.log(
      "[pokapali] announce received:",
      ann.cid.slice(0, 16) + "...",
    );
    pendingCid = ann.cid;
    const cid = CIDClass.parse(ann.cid);
    onSnapshot(cid).catch((err) => {
      console.error(
        "[pokapali] announce apply failed:",
        err,
      );
      scheduleRetry();
    });
  };

  pubsub.addEventListener(
    "message",
    announceHandler,
  );

  // --- IPNS polling fallback ---

  let stopWatch: (() => void) | null = null;
  if (ipnsPublicKeyBytes) {
    stopWatch = watchIPNS(
      getHelia(),
      ipnsPublicKeyBytes,
      async (cid) => {
        try {
          pendingCid = cid.toString();
          await onSnapshot(cid);
          pendingCid = null;
        } catch {
          scheduleRetry();
        }
      },
    );
  }

  // --- Re-announce timer (writers only) ---

  let announceTimer: ReturnType<
    typeof setInterval
  > | null = null;

  return {
    startReannounce(getCid, getBlock) {
      if (announceTimer) return;
      // Subscribe so writer joins the GossipSub
      // mesh for the announce topic.
      pubsub.subscribe(topic);
      announceTimer = setInterval(() => {
        const cid = getCid();
        if (!cid) return;
        const cidStr = cid.toString();
        const block = getBlock(cidStr);
        if (block) {
          const helia = getHelia();
          Promise.resolve(
            helia.blockstore.put(cid, block),
          ).catch(() => {});
        }
        announceSnapshot(
          pubsub as unknown as AnnouncePubSub,
          appId,
          ipnsName,
          cidStr,
        );
      }, REANNOUNCE_MS);
    },

    destroy() {
      destroyed = true;
      if (announceTimer) {
        clearInterval(announceTimer);
        announceTimer = null;
      }
      if (stopWatch) {
        stopWatch();
        stopWatch = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      pubsub.removeEventListener(
        "message",
        announceHandler,
      );
    },
  };
}
```

### Step 4: Run the test — expect PASS

Run: `cd packages/core && npx vitest run src/snapshot-watcher.test.ts`
Expected: PASS

### Step 5: Integrate into index.ts

In `createCollabDoc`, replace the announce/IPNS watch
setup (lines 331-496) with:

```ts
let snapshotWatcher: SnapshotWatcher | null = null;
if (readKey && params.pubsub && params.appId) {
  const rk = readKey;
  snapshotWatcher = createSnapshotWatcher({
    appId: params.appId,
    ipnsName,
    pubsub: params.pubsub,
    getHelia: () => getHelia(),
    isWriter: cap.canPushSnapshots,
    ipnsPublicKeyBytes: hexToBytes(ipnsName),
    onSnapshot: async (cid) => {
      const applied = await snapshotLC.applyRemote(
        cid,
        rk,
        (plaintext) =>
          subdocManager.applySnapshot(plaintext),
      );
      if (applied) {
        emit("snapshot-applied");
      }
    },
  });

  // Writers start re-announce
  if (cap.canPushSnapshots) {
    snapshotWatcher.startReannounce(
      () => snapshotLC.prev,
      (cidStr) => snapshotLC.getBlock(cidStr),
    );
  }
}
```

Remove from `createCollabDoc`:
- `announceTimer` and its `setInterval` (lines 334-366)
- `stopWatch`, `announceHandler`, `retryTimer` variables
  and all the IPNS/announce logic (lines 377-496)
- The `isReadOnly` variable (line 374-376)

Update `destroy()` to call
`snapshotWatcher?.destroy()` instead of individually
clearing each timer/listener.

### Step 6: Run full test suite — expect PASS

Run: `cd packages/core && npx vitest run`
Expected: All tests pass

### Step 7: Commit

```bash
git add packages/core/src/snapshot-watcher.ts \
        packages/core/src/snapshot-watcher.test.ts \
        packages/core/src/index.ts
git commit -m "refactor(core): extract snapshot watcher to own module"
```

---

## Task 4: Extract `relay-sharing.ts`

This module handles exchanging relay entries between
peers via the Yjs awareness protocol.

**Files:**
- Create: `packages/core/src/relay-sharing.ts`
- Create: `packages/core/src/relay-sharing.test.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Write the test

```ts
// packages/core/src/relay-sharing.test.ts
import { describe, it, expect, vi, afterEach } from
  "vitest";
import { createRelaySharing } from
  "./relay-sharing.js";

function mockAwareness() {
  const listeners = new Map<
    string,
    Set<Function>
  >();
  return {
    clientID: 1,
    setLocalStateField: vi.fn(),
    getStates: vi.fn(() => new Map()),
    on(event: string, cb: Function) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },
    off(event: string, cb: Function) {
      listeners.get(event)?.delete(cb);
    },
    _emit(event: string, ...args: unknown[]) {
      const cbs = listeners.get(event);
      if (cbs) for (const cb of cbs) cb(...args);
    },
  };
}

describe("createRelaySharing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes relay entries to awareness", () => {
    vi.useFakeTimers();
    const awareness = mockAwareness();
    const rd = {
      relayEntries: vi.fn(() => [
        { peerId: "p1", addrs: ["/ip4/1.2.3.4"] },
      ]),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    // Initial publish fires after 5s delay
    vi.advanceTimersByTime(5_000);
    expect(
      awareness.setLocalStateField,
    ).toHaveBeenCalledWith(
      "relays",
      [{ peerId: "p1", addrs: ["/ip4/1.2.3.4"] }],
    );

    sharing.destroy();
  });

  it(
    "consumes relay entries from other peers",
    () => {
      const awareness = mockAwareness();
      const states = new Map();
      states.set(1, {}); // self — no relays
      states.set(2, {
        relays: [
          { peerId: "p2", addrs: ["/ip4/5.6.7.8"] },
        ],
      });
      awareness.getStates = vi.fn(() => states);

      const rd = {
        relayEntries: vi.fn(() => []),
        addExternalRelays: vi.fn(),
      };

      const sharing = createRelaySharing({
        awareness: awareness as any,
        roomDiscovery: rd as any,
      });

      // Simulate awareness update
      awareness._emit("update");

      expect(
        rd.addExternalRelays,
      ).toHaveBeenCalledWith([
        { peerId: "p2", addrs: ["/ip4/5.6.7.8"] },
      ]);

      sharing.destroy();
    },
  );

  it("destroy clears timers", () => {
    vi.useFakeTimers();
    const awareness = mockAwareness();
    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });
    sharing.destroy();

    // Advancing time should not cause errors
    vi.advanceTimersByTime(60_000);
  });
});
```

### Step 2: Run the test — expect FAIL

Run: `cd packages/core && npx vitest run src/relay-sharing.test.ts`
Expected: FAIL — module not found

### Step 3: Write `relay-sharing.ts`

```ts
// packages/core/src/relay-sharing.ts
import type { Awareness } from "y-protocols/awareness";
import type { RoomDiscovery } from
  "./peer-discovery.js";

const PUBLISH_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 5_000;

export interface RelaySharingOptions {
  awareness: Awareness;
  roomDiscovery: RoomDiscovery;
}

export interface RelaySharing {
  destroy(): void;
}

export function createRelaySharing(
  options: RelaySharingOptions,
): RelaySharing {
  const { awareness, roomDiscovery } = options;

  const publishRelays = () => {
    const entries = roomDiscovery.relayEntries();
    if (entries.length > 0) {
      awareness.setLocalStateField(
        "relays",
        entries,
      );
    }
  };

  const onAwarenessUpdate = () => {
    const states = awareness.getStates();
    for (const [clientId, state] of states) {
      if (clientId === awareness.clientID) continue;
      const relays = (state as any)?.relays;
      if (
        Array.isArray(relays) &&
        relays.length > 0
      ) {
        roomDiscovery.addExternalRelays(relays);
      }
    }
  };

  awareness.on("update", onAwarenessUpdate);

  const publishTimer = setInterval(
    publishRelays,
    PUBLISH_INTERVAL_MS,
  );
  const initialTimer = setTimeout(
    publishRelays,
    INITIAL_DELAY_MS,
  );

  return {
    destroy() {
      clearInterval(publishTimer);
      clearTimeout(initialTimer);
      awareness.off("update", onAwarenessUpdate);
    },
  };
}
```

### Step 4: Run the test — expect PASS

Run: `cd packages/core && npx vitest run src/relay-sharing.test.ts`
Expected: PASS

### Step 5: Integrate into index.ts

In `createCollabDoc`, replace the relay sharing block
(lines 288-329) with:

```ts
let relaySharing: RelaySharing | null = null;
if (params.roomDiscovery) {
  relaySharing = createRelaySharing({
    awareness: awarenessRoom.awareness,
    roomDiscovery: params.roomDiscovery,
  });
}
```

Update `destroy()` to call
`relaySharing?.destroy()` instead of the manual
`clearInterval(relayShareTimer)`.

Remove from `createCollabDoc`:
- `relayShareTimer` variable (lines 288-290)
- The entire relay sharing block (lines 291-329)

### Step 6: Run full test suite — expect PASS

Run: `cd packages/core && npx vitest run`
Expected: All tests pass

### Step 7: Commit

```bash
git add packages/core/src/relay-sharing.ts \
        packages/core/src/relay-sharing.test.ts \
        packages/core/src/index.ts
git commit -m "refactor(core): extract relay sharing to own module"
```

---

## Task 5: Clean up index.ts and verify

After all extractions, `index.ts` should be
significantly shorter. This task is a cleanup pass.

**Files:**
- Modify: `packages/core/src/index.ts`

### Step 1: Audit the remaining index.ts

Expected remaining content (~450-550 lines):
- Imports
- `CollabLibOptions`, `DocStatus`, `RotateResult`,
  `CollabDoc`, `CollabLib` interfaces
- `computeStatus` helper
- `DEFAULT_ICE_SERVERS` constant
- `CollabDocParams` interface
- `createCollabDoc()` — now ~250 lines:
  - Event system (listeners, emit, on, off)
  - Status tracking
  - snapshotLC + snapshotWatcher + relaySharing setup
  - Thin delegation for subdoc, inviteUrl, pushSnapshot,
    history, loadVersion, rotate, destroy
- `createCollabLib()` — unchanged (~320 lines)
- Re-exports

### Step 2: Remove dead imports

After extraction, some imports in index.ts will be
unused. Remove them:
- `CID` import (if only used by extracted modules)
- `sha256` import (moved to snapshot-lifecycle)
- `decodeSnapshot`, `decryptSnapshot`, `walkChain`
  (moved to snapshot-lifecycle)
- `watchIPNS` (moved to snapshot-watcher)
- `announceTopic`, `parseAnnouncement` (moved to
  snapshot-watcher)

Keep:
- `encodeSnapshot` — no, this moved to
  snapshot-lifecycle too
- `announceSnapshot` — check if still used in
  pushSnapshot; if delegated to watcher, remove
- `publishIPNS` — still used in pushSnapshot's
  fire-and-forget block
- `hexToBytes` — still used for ipnsPublicKeyBytes
- `getHelia` — still used and re-exported

### Step 3: Verify no unused variables or imports

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

### Step 4: Run full monorepo test suite

Run: `npm test` (from repo root)
Expected: All tests pass across all packages

### Step 5: Verify line count reduction

Run: `wc -l packages/core/src/index.ts`
Expected: ~450-550 lines (down from 1308)

Verify new files:
```
wc -l packages/core/src/fetch-block.ts
wc -l packages/core/src/snapshot-lifecycle.ts
wc -l packages/core/src/snapshot-watcher.ts
wc -l packages/core/src/relay-sharing.ts
```

Total lines across all files should be roughly similar
to the original 1308 (code wasn't deleted, just moved),
but each file should be under 300 lines.

### Step 6: Commit

```bash
git add packages/core/src/index.ts
git commit -m "refactor(core): clean up index.ts after decomposition"
```

---

## Task 6: Final integration test

Verify the full monorepo builds and all tests pass.

### Step 1: Clean build

Run: `npm run build` (from repo root)
Expected: No errors

### Step 2: Full test suite

Run: `npm test` (from repo root)
Expected: All tests pass

### Step 3: Verify exports unchanged

The `packages/core/package.json` exports field should
not need changes — only `index.ts` is the entry point,
and the new modules are internal.

Check that the example app still builds:
Run: `cd apps/example && npm run build`
Expected: No errors

### Step 4: Final commit if any remaining changes

```bash
git add -A
git status  # verify nothing unexpected
git commit -m "refactor(core): complete index.ts decomposition"
```

---

## Summary

| File | Before | After (approx) |
|---|---|---|
| `index.ts` | 1308 lines | ~500 lines |
| `fetch-block.ts` | — | ~50 lines |
| `snapshot-lifecycle.ts` | — | ~200 lines |
| `snapshot-watcher.ts` | — | ~170 lines |
| `relay-sharing.ts` | — | ~70 lines |

New test files:
- `fetch-block.test.ts`
- `snapshot-lifecycle.test.ts`
- `snapshot-watcher.test.ts`
- `relay-sharing.test.ts`

**No public API changes.** The `CollabDoc` and
`CollabLib` interfaces are identical. The `createCollabLib`
function signature is identical. All existing tests
continue to pass.
