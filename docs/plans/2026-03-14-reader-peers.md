# Reader Peers Implementation Plan (#171)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `--readers N` in the load-test
CLI so reader peers open writer docs, verify CRDT
convergence via clockSum, and track sync latency.

**Architecture:** New `src/reader-peer.ts` module
subscribes to GossipSub, decodes inline blocks,
decrypts snapshots, applies Yjs updates, compares
`text.length` against announced clockSum. Writers
expose `readKey`. `bin/run.ts` spawns reader peers
on a separate Helia node.

**Tech Stack:** Yjs, GossipSub, @pokapali/snapshot
(decodeSnapshot, decryptSnapshot), @pokapali/core
(announce parsing, base64ToUint8), @pokapali/crypto
(deriveDocKeys)

---

## Important context

- **Announcement format:** Writer calls
  `announceSnapshot(pubsub, appId, ipnsName, cid,
clockSum, block)` where the 5th arg (clockSum =
  `text.length`) is stored as `announcement.seq`.
  The reader uses `announcement.seq` as the
  expected text length.

- **Block encoding:** Inline block is base64-encoded
  in `announcement.block`. Use `base64ToUint8()`
  from `@pokapali/core/announce` to decode.

- **Snapshot structure:** `decodeSnapshot(blockBytes)`
  returns `SnapshotNode` with encrypted `.subdocs`.
  `decryptSnapshot(node, readKey)` returns
  `Record<string, Uint8Array>` — the `"content"`
  key has the Yjs state update.

- **Writer readKey:** The writer already derives
  `keys.readKey` via `deriveDocKeys()`. Currently
  not exposed on the `Writer` interface — needs a
  one-line change.

- **Existing reader.ts:** GossipSub-only observer
  used in smoke tests. Do NOT modify it.

- **Test file location:** Tests go alongside source:
  `src/reader-peer.test.ts`

- **Double quotes, 80-char lines, ESM.**

---

### Task 1: Expose readKey from Writer

**Files:**

- Modify: `packages/load-test/src/writer.ts`

**Step 1: Add readKey to Writer interface**

In `writer.ts`, add `readKey` to the `Writer`
interface (line 62-69):

```typescript
export interface Writer {
  /** Hex-encoded IPNS public key. */
  readonly ipnsName: string;
  /** Unique writer identifier. */
  readonly writerId: string;
  /** Read key for decrypting snapshots. */
  readonly readKey: CryptoKey;
  /** Stop the writer loop and unsubscribe. */
  stop(): void;
}
```

And in the return object of `startWriter` (line
258), add:

```typescript
  return {
    ipnsName,
    writerId,
    readKey: keys.readKey,
    stop() { ... },
  };
```

**Step 2: Verify build**

Run: `npm run build -w packages/load-test`
Expected: clean build, no errors

**Step 3: Commit**

```bash
git add packages/load-test/src/writer.ts
git commit -m "Expose readKey from Writer interface"
```

---

### Task 2: Add new event types to LoadTestEvent

**Files:**

- Modify: `packages/load-test/src/metrics.ts`

**Step 1: Extend LoadTestEvent type union**

In `metrics.ts` (line 6-12), add reader event types:

```typescript
export interface LoadTestEvent {
  ts: number;
  type:
    | "snapshot-pushed"
    | "ack-received"
    | "status-change"
    | "error"
    | "doc-created"
    | "doc-ready"
    | "reader-synced"
    | "convergence-ok"
    | "convergence-drift";
  docId: string;
  latencyMs?: number;
  detail?: string;
  cid?: string;
  /** ms epoch until pinner re-announces. */
  guaranteeUntil?: number;
  /** ms epoch until pinner retains blocks. */
  retainUntil?: number;
  /** Expected clockSum from writer announcement. */
  expectedClockSum?: number;
  /** Actual text length in reader's Y.Doc. */
  actualClockSum?: number;
}
```

**Step 2: Verify build**

Run: `npm run build -w packages/load-test`
Expected: clean build

**Step 3: Commit**

```bash
git add packages/load-test/src/metrics.ts
git commit -m "Add reader-synced and convergence event types to metrics"
```

---

### Task 3: Write reader-peer tests (RED)

**Files:**

- Create: `packages/load-test/src/reader-peer.test.ts`

Write tests for reader-peer behavior. The tests
use real GossipSub message handling logic by
constructing announcement payloads and calling
the message handler directly.

**Step 1: Write test file**

```typescript
import { describe, test, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { encodeSnapshot } from "@pokapali/snapshot";
import {
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  generateAdminSecret,
  bytesToHex,
} from "@pokapali/crypto";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";

// Will be created in Task 4
import { startReaderPeer, type ReaderPeerEvent } from "./reader-peer.js";

const DAG_CBOR_CODE = 0x71;
const APP_ID = "test-app";

// Helper: create a writer's keys and a snapshot
// block from a Y.Doc with given text content.
async function makeWriterFixture(content: string) {
  const adminSecret = generateAdminSecret();
  const keys = await deriveDocKeys(adminSecret, APP_ID, ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  const ipnsName = bytesToHex(signingKey.publicKey);

  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);

  const state = Y.encodeStateAsUpdate(doc);
  const block = await encodeSnapshot(
    { content: state },
    keys.readKey,
    null,
    1,
    Date.now(),
    signingKey,
  );

  const hash = await sha256.digest(block);
  const cid = CID.createV1(DAG_CBOR_CODE, hash);

  return {
    ipnsName,
    readKey: keys.readKey,
    block,
    cid: cid.toString(),
    clockSum: content.length,
    doc,
  };
}

// Helper: build a raw GossipSub announcement
// message as Uint8Array (what parseAnnouncement
// would receive).
function makeAnnouncementPayload(opts: {
  ipnsName: string;
  cid: string;
  seq?: number;
  block?: Uint8Array;
  ack?: { peerId: string };
}): Uint8Array {
  let blockB64: string | undefined;
  if (opts.block) {
    let binary = "";
    for (let i = 0; i < opts.block.length; i++) {
      binary += String.fromCharCode(opts.block[i]);
    }
    blockB64 = btoa(binary);
  }

  const msg: Record<string, unknown> = {
    ipnsName: opts.ipnsName,
    cid: opts.cid,
  };
  if (opts.seq !== undefined) msg.seq = opts.seq;
  if (blockB64) msg.block = blockB64;
  if (opts.ack) msg.ack = opts.ack;

  return new TextEncoder().encode(JSON.stringify(msg));
}

describe("startReaderPeer", () => {
  test("decodes and applies snapshot from announcement", async () => {
    const fixture = await makeWriterFixture("hello");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    // Create a mock pubsub that captures the
    // message handler
    let handler: ((evt: unknown) => void) | null = null;
    const pubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addEventListener: vi.fn((_: string, h: (evt: unknown) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    // Simulate receiving an announcement
    const payload = makeAnnouncementPayload({
      ipnsName: fixture.ipnsName,
      cid: fixture.cid,
      seq: fixture.clockSum,
      block: fixture.block,
    });

    // Dispatch as GossipSub message event
    handler!({
      detail: {
        topic: `/pokapali/app/${APP_ID}/announce`,
        data: payload,
      },
    });

    // Allow async processing
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    expect(peer.syncedDocs.has(fixture.ipnsName)).toBe(true);

    const synced = events.find((e) => e.type === "reader-synced");
    expect(synced).toBeDefined();
    expect(synced!.ipnsName).toBe(fixture.ipnsName);
    expect(synced!.cid).toBe(fixture.cid);

    const conv = events.find((e) => e.type === "convergence-ok");
    expect(conv).toBeDefined();
    expect(conv!.expectedClockSum).toBe(5);
    expect(conv!.actualClockSum).toBe(5);

    peer.stop();
  });

  test("ignores ack announcements", async () => {
    const fixture = await makeWriterFixture("test");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    let handler: ((evt: unknown) => void) | null = null;
    const pubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addEventListener: vi.fn((_: string, h: (evt: unknown) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    const payload = makeAnnouncementPayload({
      ipnsName: fixture.ipnsName,
      cid: fixture.cid,
      ack: { peerId: "pinner-1" },
    });

    handler!({
      detail: {
        topic: `/pokapali/app/${APP_ID}/announce`,
        data: payload,
      },
    });

    // Give time for any async processing
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(0);

    peer.stop();
  });

  test("ignores announcements for unknown writers", async () => {
    const fixture = await makeWriterFixture("test");
    const events: ReaderPeerEvent[] = [];

    // Empty writers map — no tracked writers
    const writers = new Map<string, CryptoKey>();

    let handler: ((evt: unknown) => void) | null = null;
    const pubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addEventListener: vi.fn((_: string, h: (evt: unknown) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    const payload = makeAnnouncementPayload({
      ipnsName: fixture.ipnsName,
      cid: fixture.cid,
      seq: fixture.clockSum,
      block: fixture.block,
    });

    handler!({
      detail: {
        topic: `/pokapali/app/${APP_ID}/announce`,
        data: payload,
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(0);
    expect(peer.syncedDocs.size).toBe(0);

    peer.stop();
  });

  test("reports convergence-drift on clockSum mismatch", async () => {
    const fixture = await makeWriterFixture("hello");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    let handler: ((evt: unknown) => void) | null = null;
    const pubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addEventListener: vi.fn((_: string, h: (evt: unknown) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    // Send announcement with wrong clockSum
    const payload = makeAnnouncementPayload({
      ipnsName: fixture.ipnsName,
      cid: fixture.cid,
      seq: 999, // wrong — actual is 5
      block: fixture.block,
    });

    handler!({
      detail: {
        topic: `/pokapali/app/${APP_ID}/announce`,
        data: payload,
      },
    });

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    const drift = events.find((e) => e.type === "convergence-drift");
    expect(drift).toBeDefined();
    expect(drift!.expectedClockSum).toBe(999);
    expect(drift!.actualClockSum).toBe(5);

    peer.stop();
  });

  test("ignores announcements without inline block", async () => {
    const fixture = await makeWriterFixture("test");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    let handler: ((evt: unknown) => void) | null = null;
    const pubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addEventListener: vi.fn((_: string, h: (evt: unknown) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    // Announcement without block
    const payload = makeAnnouncementPayload({
      ipnsName: fixture.ipnsName,
      cid: fixture.cid,
      seq: fixture.clockSum,
      // no block!
    });

    handler!({
      detail: {
        topic: `/pokapali/app/${APP_ID}/announce`,
        data: payload,
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(0);

    peer.stop();
  });

  test("tracks convergenceErrors count", async () => {
    const fixture = await makeWriterFixture("hello");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    let handler: ((evt: unknown) => void) | null = null;
    const pubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addEventListener: vi.fn((_: string, h: (evt: unknown) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    expect(peer.convergenceErrors).toBe(0);

    const payload = makeAnnouncementPayload({
      ipnsName: fixture.ipnsName,
      cid: fixture.cid,
      seq: 999,
      block: fixture.block,
    });

    handler!({
      detail: {
        topic: `/pokapali/app/${APP_ID}/announce`,
        data: payload,
      },
    });

    await vi.waitFor(() => {
      expect(peer.convergenceErrors).toBe(1);
    });

    peer.stop();
  });

  test("stop unsubscribes from pubsub", async () => {
    const writers = new Map<string, CryptoKey>();
    const pubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
    });

    peer.stop();

    expect(pubsub.removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
    expect(pubsub.unsubscribe).toHaveBeenCalledWith(
      `/pokapali/app/${APP_ID}/announce`,
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/reader-peer.test.ts
  -w packages/load-test`
Expected: FAIL — module `./reader-peer.js` not found

**Step 3: Commit**

```bash
git add packages/load-test/src/reader-peer.test.ts
git commit -m "Add reader-peer tests (RED)"
```

---

### Task 4: Implement reader-peer module (GREEN)

**Files:**

- Create: `packages/load-test/src/reader-peer.ts`

**Step 1: Write minimal implementation**

```typescript
/**
 * Active reader peer for load testing.
 *
 * Subscribes to GossipSub, decodes inline snapshot
 * blocks, decrypts and applies Yjs state, verifies
 * convergence via clockSum comparison.
 */

import * as Y from "yjs";
import {
  parseAnnouncement,
  announceTopic,
  base64ToUint8,
} from "@pokapali/core/announce";
import { decodeSnapshot, decryptSnapshot } from "@pokapali/snapshot";
import { createLogger } from "@pokapali/log";

const log = createLogger("load-test:reader-peer");

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

export interface ReaderPeerConfig {
  /** Application ID for GossipSub topic. */
  appId: string;
  /** Map of ipnsName → readKey for tracked writers. */
  writers: ReadonlyMap<string, CryptoKey>;
  /** Callback for event collection. */
  onEvent?: (event: ReaderPeerEvent) => void;
}

export interface ReaderPeer {
  /** Unique peer identifier. */
  readonly peerId: string;
  /** ipnsNames that have been successfully synced. */
  readonly syncedDocs: ReadonlySet<string>;
  /** Count of convergence mismatches. */
  readonly convergenceErrors: number;
  /** Stop the reader peer and unsubscribe. */
  stop(): void;
}

interface PubSubLike {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  addEventListener(type: string, handler: (evt: unknown) => void): void;
  removeEventListener(type: string, handler: (evt: unknown) => void): void;
}

let peerCounter = 0;

export function startReaderPeer(
  pubsub: PubSubLike,
  config: ReaderPeerConfig,
): ReaderPeer {
  const appId = config.appId;
  const writers = config.writers;
  const onEvent = config.onEvent ?? (() => {});
  const peerId = `reader-peer-${++peerCounter}`;

  const topic = announceTopic(appId);
  pubsub.subscribe(topic);

  const syncedDocs = new Set<string>();
  let convergenceErrors = 0;

  // Per-writer Y.Doc state
  const docs = new Map<string, Y.Doc>();

  function getOrCreateDoc(ipnsName: string): Y.Doc {
    let doc = docs.get(ipnsName);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(ipnsName, doc);
    }
    return doc;
  }

  const messageHandler = (evt: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (evt as any)?.detail;
    if (!detail || detail.topic !== topic) return;

    const announcement = parseAnnouncement(detail.data);
    if (!announcement) return;

    // Skip acks
    if (announcement.ack) return;

    // Skip writers we're not tracking
    const readKey = writers.get(announcement.ipnsName);
    if (!readKey) return;

    // Skip announcements without inline block
    if (!announcement.block) return;

    const receiveTs = Date.now();

    // Process async — decode, decrypt, apply
    processAnnouncement(
      announcement.ipnsName,
      announcement.cid,
      announcement.block,
      announcement.seq,
      readKey,
      receiveTs,
    ).catch((err) => {
      onEvent({
        type: "error",
        peerId,
        timestampMs: Date.now(),
        ipnsName: announcement.ipnsName,
        cid: announcement.cid,
        error: (err as Error).message ?? String(err),
      });
    });
  };

  async function processAnnouncement(
    ipnsName: string,
    cid: string,
    blockB64: string,
    expectedClockSum: number | undefined,
    readKey: CryptoKey,
    receiveTs: number,
  ): Promise<void> {
    const blockBytes = base64ToUint8(blockB64);
    const node = decodeSnapshot(blockBytes);
    const plaintext = await decryptSnapshot(node, readKey);

    const contentUpdate = plaintext["content"];
    if (!contentUpdate) return;

    const doc = getOrCreateDoc(ipnsName);
    Y.applyUpdate(doc, contentUpdate);

    syncedDocs.add(ipnsName);

    const actualClockSum = doc.getText("content").length;
    const latencyMs = Date.now() - receiveTs;

    onEvent({
      type: "reader-synced",
      peerId,
      timestampMs: Date.now(),
      ipnsName,
      cid,
      latencyMs,
    });

    log.debug(
      `${peerId} synced`,
      `ipns=${ipnsName.slice(0, 12)}...`,
      `cid=${cid.slice(0, 12)}...`,
      `latency=${latencyMs}ms`,
    );

    // Convergence check
    if (expectedClockSum !== undefined) {
      if (actualClockSum === expectedClockSum) {
        onEvent({
          type: "convergence-ok",
          peerId,
          timestampMs: Date.now(),
          ipnsName,
          cid,
          expectedClockSum,
          actualClockSum,
        });
      } else {
        convergenceErrors++;
        onEvent({
          type: "convergence-drift",
          peerId,
          timestampMs: Date.now(),
          ipnsName,
          cid,
          expectedClockSum,
          actualClockSum,
        });
        log.warn(
          `${peerId} convergence drift`,
          `ipns=${ipnsName.slice(0, 12)}...`,
          `expected=${expectedClockSum}`,
          `actual=${actualClockSum}`,
        );
      }
    }
  }

  pubsub.addEventListener("message", messageHandler);

  log.info(`${peerId} started,`, `tracking ${writers.size} writer(s)`);

  return {
    peerId,
    get syncedDocs() {
      return syncedDocs as ReadonlySet<string>;
    },
    get convergenceErrors() {
      return convergenceErrors;
    },
    stop() {
      pubsub.removeEventListener("message", messageHandler);
      pubsub.unsubscribe(topic);
      for (const doc of docs.values()) {
        doc.destroy();
      }
      docs.clear();
      log.info(`${peerId} stopped`);
    },
  };
}
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/reader-peer.test.ts
  -w packages/load-test`
Expected: all 7 tests PASS

**Step 3: Format and lint**

Run: `npx prettier --write
  packages/load-test/src/reader-peer.ts
  packages/load-test/src/reader-peer.test.ts`

**Step 4: Commit**

```bash
git add packages/load-test/src/reader-peer.ts \
  packages/load-test/src/reader-peer.test.ts
git commit -m "Implement reader-peer module (GREEN)"
```

---

### Task 5: Wire reader peers into bin/run.ts

**Files:**

- Modify: `packages/load-test/bin/run.ts`

**Step 1: Add imports and reader peer spawning**

Add import at top:

```typescript
import {
  startReaderPeer,
  type ReaderPeer,
  type ReaderPeerEvent,
} from "../src/reader-peer.js";
```

Add a `mapReaderEvent` function (after
`mapWriterEvent`):

```typescript
function mapReaderEvent(
  event: ReaderPeerEvent,
): Parameters<ReturnType<typeof createMetrics>["record"]>[0] | null {
  switch (event.type) {
    case "reader-synced":
      return {
        ts: event.timestampMs,
        type: "reader-synced",
        docId: event.ipnsName
          ? `reader:${event.ipnsName.slice(0, 12)}`
          : "reader:unknown",
        latencyMs: event.latencyMs,
        cid: event.cid,
      };
    case "convergence-ok":
      return {
        ts: event.timestampMs,
        type: "convergence-ok",
        docId: event.ipnsName
          ? `reader:${event.ipnsName.slice(0, 12)}`
          : "reader:unknown",
        expectedClockSum: event.expectedClockSum,
        actualClockSum: event.actualClockSum,
      };
    case "convergence-drift":
      return {
        ts: event.timestampMs,
        type: "convergence-drift",
        docId: event.ipnsName
          ? `reader:${event.ipnsName.slice(0, 12)}`
          : "reader:unknown",
        expectedClockSum: event.expectedClockSum,
        actualClockSum: event.actualClockSum,
      };
    case "error":
      return {
        ts: event.timestampMs,
        type: "error",
        docId: `reader:${event.peerId}`,
        detail: event.error,
      };
    default:
      return null;
  }
}
```

After the writers-spawn loop (line 173), add reader
peer spawning:

```typescript
const readerPeers: ReaderPeer[] = [];

if (config.readers > 0) {
  // Collect writer keys for reader peers
  const writerKeys = new Map<string, CryptoKey>();
  for (const w of writers) {
    writerKeys.set(w.ipnsName, w.readKey);
  }

  // Create separate Helia node for readers
  log.info("creating reader Helia node...");
  const readerHelia: HeliaNode = await createHeliaNode({
    bootstrapPeers: config.bootstrap,
  });
  log.info("reader Helia ready");

  // Connect reader to writer node for GossipSub
  const writerAddrs = helia.libp2p.getMultiaddrs();
  for (const ma of writerAddrs) {
    try {
      await readerHelia.libp2p.dial(ma);
      log.info("reader dialed writer:", ma.toString().slice(-30));
      break;
    } catch {
      // try next addr
    }
  }

  for (let i = 0; i < config.readers; i++) {
    const peer = startReaderPeer(readerHelia.libp2p.services.pubsub, {
      appId: config.appId,
      writers: writerKeys,
      onEvent(event: ReaderPeerEvent) {
        const mapped = mapReaderEvent(event);
        if (mapped) metrics.record(mapped);
      },
    });
    readerPeers.push(peer);
    log.info(`${peer.peerId} started`);
  }
}
```

Update the shutdown section (after the duration
wait) to stop readers and reader Helia:

```typescript
// Stop all readers
for (const r of readerPeers) {
  r.stop();
}

// Stop all writers
log.info("stopping writers...");
for (const w of writers) {
  w.stop();
}

// Stop Helia nodes
log.info("stopping Helia...");
await helia.stop();
if (readerHelia) await readerHelia.stop();
```

Note: `readerHelia` needs to be declared in the
outer scope. Move the declaration before the
`if (config.readers > 0)` block:

```typescript
let readerHelia: HeliaNode | null = null;
```

And update the creation to assign:

```typescript
  readerHelia = await createHeliaNode({...});
```

And shutdown:

```typescript
if (readerHelia) await readerHelia.stop();
```

Also update the log line to include reader count:

```typescript
  log.info(
    `starting: ${config.docs} docs,` +
      ` ${config.readers} readers,` +
      ` ${config.intervalMs}ms interval,` +
      ...
  );
```

**Step 2: Verify build**

Run: `npm run build -w packages/load-test`
Expected: clean build

**Step 3: Commit**

```bash
git add packages/load-test/bin/run.ts
git commit -m "Wire reader peers into load-test CLI"
```

---

### Task 6: Export reader-peer from index.ts

**Files:**

- Modify: `packages/load-test/src/index.ts`

**Step 1: Add exports**

```typescript
export {
  startReaderPeer,
  type ReaderPeer,
  type ReaderPeerConfig,
  type ReaderPeerEvent,
} from "./reader-peer.js";
```

**Step 2: Verify build**

Run: `npm run build -w packages/load-test`
Expected: clean build

**Step 3: Commit**

```bash
git add packages/load-test/src/index.ts
git commit -m "Export reader-peer from load-test index"
```

---

### Task 7: Update analyze.ts for reader events

**Files:**

- Modify: `packages/load-test/bin/analyze.ts`

**Step 1: Add reader metrics to analysis**

Add tracking variables after line 105:

```typescript
let readerSyncs = 0;
let convergenceOk = 0;
let convergenceDrift = 0;
const syncLatencies: number[] = [];
```

Add cases to the switch in the event loop:

```typescript
      case "reader-synced":
        readerSyncs++;
        if (event.latencyMs != null) {
          syncLatencies.push(event.latencyMs);
        }
        break;

      case "convergence-ok":
        convergenceOk++;
        break;

      case "convergence-drift":
        convergenceDrift++;
        break;
```

Add reader summary lines after existing summary
(before checks):

```typescript
if (readerSyncs > 0) {
  const sortedSync = syncLatencies.slice().sort((a, b) => a - b);
  const syncP50 = percentile(sortedSync, 0.5);
  const syncP95 = percentile(sortedSync, 0.95);
  console.log(`  Reader syncs:  ${readerSyncs}`);
  console.log(
    `  Convergence:   ` + `${convergenceOk} ok, ` + `${convergenceDrift} drift`,
  );
  console.log(`  Sync p50:      ${syncP50}ms`);
  console.log(`  Sync p95:      ${syncP95}ms`);
}
```

Add convergence-drift check (before the error
check):

```typescript
if (convergenceDrift > 0) {
  checks.push({
    name: "Convergence",
    pass: false,
    detail: `${convergenceDrift} drift(s) detected`,
  });
} else if (convergenceOk > 0) {
  checks.push({
    name: "Convergence",
    pass: true,
    detail: `${convergenceOk} checks passed`,
  });
}
```

**Step 2: Verify build**

Run: `npm run build -w packages/load-test`
Expected: clean build

**Step 3: Commit**

```bash
git add packages/load-test/bin/analyze.ts
git commit -m "Add reader sync and convergence metrics to analyze"
```

---

### Task 8: Format, lint, full test suite

**Step 1: Format all modified files**

Run: `npx prettier --write
  packages/load-test/src/reader-peer.ts
  packages/load-test/src/reader-peer.test.ts
  packages/load-test/src/writer.ts
  packages/load-test/src/metrics.ts
  packages/load-test/src/index.ts
  packages/load-test/bin/run.ts
  packages/load-test/bin/analyze.ts`

**Step 2: Run full test suite**

Run: `npm test` (from repo root)
Expected: all tests pass including new reader-peer
tests

**Step 3: Run verify-branch.sh**

Run: `bin/verify-branch.sh`
Expected: ALL PASSED

**Step 4: Commit any formatting fixes**

```bash
git add -u
git commit -m "Format and lint reader-peer implementation"
```

---

### Task 9: Request merge

Report to PM with verify-branch results.
