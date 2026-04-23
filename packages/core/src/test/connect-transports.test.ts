/**
 * D4a: Two-runtime Node integration test.
 *
 * Proves the reconciliation pipeline end-to-end
 * in pure Node: Alice and Bob create Documents,
 * wire PeerSync via connectTransports, and verify
 * CRDT edit sync + snapshot exchange without any
 * browser or WebRTC.
 *
 * @module
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { Document, Edit, State, Cache, foldTree } from "@pokapali/document";
import type { Document as DocumentType } from "@pokapali/document";
import type { Codec } from "@pokapali/codec";
import { createPeerSync } from "../peer-sync.js";
import type { PeerSync } from "../peer-sync.js";
import { connectTransports } from "./connect-transports.js";
import { createStubBlockResolver } from "./stub-block-resolver.js";
import type { SnapshotCatalog } from "../reconciliation-wiring.js";

// ── Helpers ──────────────────────────────────────

function fakeIdentity() {
  return {
    publicKey: new Uint8Array(32).fill(0xaa),
    privateKey: new Uint8Array(64).fill(0xbb),
  };
}

function fakeIdentity2() {
  return {
    publicKey: new Uint8Array(32).fill(0xcc),
    privateKey: new Uint8Array(64).fill(0xdd),
  };
}

function fakeCapability(channels: string[]) {
  return {
    channels: new Set(channels),
    canPushSnapshots: true,
    isAdmin: false,
  };
}

/**
 * Functional fake codec: byte-array concat+sort
 * for merge/apply, set difference for diff, and
 * linear scan for contains. Deterministic and
 * sufficient for reconciliation tests.
 */
function fakeCodec(): Codec {
  return {
    merge: (a, b) => {
      const combined = new Uint8Array([...a, ...b]);
      combined.sort();
      // Deduplicate
      const deduped: number[] = [];
      for (const byte of combined) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== byte) {
          deduped.push(byte);
        }
      }
      return new Uint8Array(deduped);
    },
    diff: (state, base) => {
      const baseSet = new Set(base);
      return new Uint8Array([...state].filter((b) => !baseSet.has(b)));
    },
    apply: (base, update) => {
      const combined = new Uint8Array([...base, ...update]);
      combined.sort();
      const deduped: number[] = [];
      for (const byte of combined) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== byte) {
          deduped.push(byte);
        }
      }
      return new Uint8Array(deduped);
    },
    empty: () => new Uint8Array([]),
    contains: (snapshot, editPayload) => {
      const id = editPayload[0]!;
      for (const b of snapshot) {
        if (b === id) return true;
      }
      return false;
    },
    createSurface() {
      throw new Error("not needed for D4a");
    },
    clockSum(state) {
      let sum = 0;
      for (const b of state) sum += b;
      return sum;
    },
  };
}

function fakeEdit(id: number, channel = "content"): Edit {
  return Edit.create({
    payload: new Uint8Array([id]),
    timestamp: Date.now(),
    author: "aabb",
    channel,
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

/**
 * Flush microtasks and timers to let mock data
 * channel events propagate. Reconciliation uses
 * a 100ms debounce timer, so we advance past it.
 */
async function flush(ms = 200): Promise<void> {
  // Flush microtasks first
  await new Promise<void>((r) => queueMicrotask(r));
  // Advance fake timers past the reconcile debounce
  vi.advanceTimersByTime(ms);
  // Flush again for any microtasks queued by timers
  await new Promise<void>((r) => queueMicrotask(r));
  await new Promise<void>((r) => queueMicrotask(r));
}

/**
 * Compute the merged state of a channel by folding
 * its epoch tree with the codec.
 */
function channelState(
  doc: DocumentType,
  codec: Codec,
  channel: string,
): Uint8Array {
  const ch = doc.channel(channel);
  const measured = State.channelMeasured(codec);
  const cache = Cache.create<Uint8Array>();
  return foldTree<Uint8Array>(measured, ch.tree, cache);
}

// ── Tests ────────────────────────────────────────

describe("connectTransports: two-runtime sync", () => {
  let aliceDoc: DocumentType;
  let bobDoc: DocumentType;
  let alicePeerSync: PeerSync;
  let bobPeerSync: PeerSync;
  let conn: { close: () => void };

  afterEach(() => {
    vi.useRealTimers();
    conn?.close();
    alicePeerSync?.destroy();
    bobPeerSync?.destroy();
    aliceDoc?.destroy();
    bobDoc?.destroy();
  });

  function setup(opts?: {
    aliceSnapshotCatalog?: () => SnapshotCatalog;
    bobSnapshotCatalog?: () => SnapshotCatalog;
    aliceOnSnapshotReceived?: (cid: unknown, data: Uint8Array) => void;
    bobOnSnapshotReceived?: (cid: unknown, data: Uint8Array) => void;
  }) {
    vi.useFakeTimers();

    const codec = fakeCodec();
    const channels = ["content"];

    aliceDoc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(channels),
      codec,
    });

    bobDoc = Document.create({
      identity: fakeIdentity2(),
      capability: fakeCapability(channels),
      codec,
    });

    const aliceEdits: Edit[] = [];
    const bobEdits: Edit[] = [];

    const aliceResolver = createStubBlockResolver();
    const bobResolver = createStubBlockResolver();

    alicePeerSync = createPeerSync({
      channels,
      document: aliceDoc,
      codec,
      persistEdit: (_ch, edit) => {
        aliceEdits.push(edit);
      },
      getSnapshotCatalog: opts?.aliceSnapshotCatalog,
      blockResolver: opts?.aliceSnapshotCatalog ? aliceResolver : undefined,
      onSnapshotReceived: opts?.aliceOnSnapshotReceived as any,
    });

    bobPeerSync = createPeerSync({
      channels,
      document: bobDoc,
      codec,
      persistEdit: (_ch, edit) => {
        bobEdits.push(edit);
      },
      getSnapshotCatalog: opts?.bobSnapshotCatalog,
      blockResolver: opts?.bobSnapshotCatalog ? bobResolver : undefined,
      onSnapshotReceived: opts?.bobOnSnapshotReceived as any,
    });

    conn = connectTransports(alicePeerSync, bobPeerSync);

    return {
      codec,
      aliceEdits,
      bobEdits,
      aliceResolver,
      bobResolver,
    };
  }

  it("Alice's edits sync to Bob via " + "reconciliation", async () => {
    const { codec, bobEdits } = setup();

    // Alice appends two edits before connection
    // opens (pre-existing state).
    aliceDoc.channel("content").appendEdit(fakeEdit(1));
    aliceDoc.channel("content").appendEdit(fakeEdit(2));

    // Let the mock peer connection open and
    // reconciliation run.
    await flush();
    await flush();
    await flush();

    // Bob should have received Alice's edits.
    const bobState = channelState(bobDoc, codec, "content");
    expect(bobState).toEqual(new Uint8Array([1, 2]));

    // Bob's persistEdit callback should have
    // been called for each synced edit.
    expect(bobEdits.length).toBeGreaterThanOrEqual(1);
  });

  it("bidirectional sync: both peers' edits " + "converge", async () => {
    const { codec } = setup();

    // Alice has edits 1, 2
    aliceDoc.channel("content").appendEdit(fakeEdit(1));
    aliceDoc.channel("content").appendEdit(fakeEdit(2));

    // Bob has edits 3, 4
    bobDoc.channel("content").appendEdit(fakeEdit(3));
    bobDoc.channel("content").appendEdit(fakeEdit(4));

    // Flush multiple rounds for bidirectional
    // reconciliation to complete.
    for (let i = 0; i < 5; i++) {
      await flush();
    }

    const aliceState = channelState(aliceDoc, codec, "content");
    const bobState = channelState(bobDoc, codec, "content");

    // Both should have all four edits.
    expect(aliceState).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(bobState).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it(
    "live edit forwarding: edits after " +
      "reconciliation are forwarded immediately",
    async () => {
      const { codec } = setup();

      // Let connection open and initial (empty)
      // reconciliation complete.
      await flush();
      await flush();

      // Alice types a new edit after connection
      // is established.
      aliceDoc.channel("content").appendEdit(fakeEdit(10));

      // Live forwarding uses the transport directly
      // (no reconciliation debounce), but the mock
      // DC delivers asynchronously.
      await flush();
      await flush();

      const bobState = channelState(bobDoc, codec, "content");
      expect(bobState).toEqual(new Uint8Array([10]));
    },
  );
});
