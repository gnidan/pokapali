/**
 * Integration tests for the full interpreter pipeline:
 * createAsyncQueue → merge → scan(reduce) → runInterpreter
 *
 * Unlike interpreter.test.ts (which feeds pre-built
 * ScanOutput), these tests wire the real pipeline and
 * verify end-to-end fact flow including feedback.
 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

import { runInterpreter } from "./interpreter.js";
import type { EffectHandlers } from "./interpreter.js";
import { initialDocState } from "./facts.js";
import type { Fact, DocState } from "./facts.js";
import { reduce } from "./reducers.js";
import { createAsyncQueue, merge, scan } from "./sources.js";
import type { AsyncQueue } from "./sources.js";

// --- Helpers ---

async function fakeCid(n: number): Promise<CID> {
  const hash = await sha256.digest(new Uint8Array([n]));
  return CID.createV1(0x71, hash);
}

function fakeBlock(n: number): Uint8Array {
  return new Uint8Array([n, n + 1, n + 2]);
}

const IDENTITY = {
  ipnsName: "test",
  role: "writer" as const,
  channels: ["content"],
  appId: "app1",
};

function mockEffects(overrides?: Partial<EffectHandlers>): EffectHandlers {
  return {
    fetchBlock: vi.fn().mockResolvedValue(null),
    applySnapshot: vi.fn().mockResolvedValue({
      seq: 1,
    }),
    getBlock: vi.fn().mockReturnValue(null),
    decodeBlock: vi.fn().mockReturnValue({}),
    isPublisherAuthorized: vi.fn().mockReturnValue(true),
    announce: vi.fn(),
    markReady: vi.fn(),
    emitSnapshotApplied: vi.fn(),
    emitAck: vi.fn(),
    emitGossipActivity: vi.fn(),
    emitLoading: vi.fn(),
    emitGuarantee: vi.fn(),
    emitStatus: vi.fn(),
    emitSaveState: vi.fn(),
    ...overrides,
  };
}

/**
 * Wire the full pipeline: input queue + feedback queue
 * → merge → scan(reduce) → runInterpreter.
 *
 * Returns the input queue (for pushing facts), the
 * feedback queue (for inspecting interpreter output),
 * and a promise that resolves when the interpreter
 * finishes.
 */
function wirePipeline(
  effects: EffectHandlers,
  ac: AbortController,
): {
  input: AsyncQueue<Fact>;
  feedback: AsyncQueue<Fact>;
  done: Promise<void>;
} {
  const input = createAsyncQueue<Fact>(ac.signal);
  const feedback = createAsyncQueue<Fact>(ac.signal);

  const merged = merge(input, feedback);
  const stateStream = scan(merged, reduce, initialDocState(IDENTITY));

  const done = runInterpreter(stateStream, effects, feedback, ac.signal);

  return { input, feedback, done };
}

/**
 * Helper to wait for async effects to settle.
 * The pipeline is async — facts flow through
 * merge → scan → interpreter → feedback in
 * microtask ticks.
 */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Tests ---

describe("interpreter pipeline integration", () => {
  it("gossip discovery triggers fetch dispatch", async () => {
    const cid = await fakeCid(1);
    const block = fakeBlock(1);

    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(block),
      decodeBlock: vi.fn().mockReturnValue({
        seq: 1,
      }),
    });

    const ac = new AbortController();
    const { input, done } = wirePipeline(effects, ac);

    // Push a gossip discovery fact
    input.push({
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });

    await settle();
    ac.abort();
    await done;

    // Interpreter should have dispatched a fetch
    expect(effects.fetchBlock).toHaveBeenCalledWith(cid);
  });

  it("full cycle: discover → fetch → apply → ready", async () => {
    const cid = await fakeCid(2);
    const block = fakeBlock(2);

    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(block),
      decodeBlock: vi.fn().mockReturnValue({
        seq: 1,
      }),
      getBlock: vi.fn().mockReturnValue(block),
      applySnapshot: vi.fn().mockResolvedValue({
        seq: 1,
      }),
    });

    const ac = new AbortController();
    const { input, done } = wirePipeline(effects, ac);

    // Push gossip discovery — triggers the full
    // fetch → tip-advanced → ready cycle via
    // feedback facts
    input.push({
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });

    await settle(100);
    ac.abort();
    await done;

    // Full cycle should have happened:
    // 1. Block resolved (via local cache fast path
    //    or async fetch — either way, decodeBlock
    //    is called)
    expect(effects.decodeBlock).toHaveBeenCalled();
    // 2. applySnapshot called (tip apply)
    expect(effects.applySnapshot).toHaveBeenCalledWith(cid, block);
    // 3. markReady called (first tip)
    expect(effects.markReady).toHaveBeenCalled();
    // 4. emitSnapshotApplied called
    expect(effects.emitSnapshotApplied).toHaveBeenCalledWith(cid, 1);
  });

  it("publish-succeeded triggers announce", async () => {
    const cid = await fakeCid(3);
    const block = fakeBlock(3);

    const effects = mockEffects({
      getBlock: vi.fn().mockReturnValue(block),
    });

    const ac = new AbortController();
    const { input, done } = wirePipeline(effects, ac);

    input.push({
      type: "publish-succeeded",
      ts: 1,
      cid,
      seq: 1,
    });

    await settle();
    ac.abort();
    await done;

    expect(effects.announce).toHaveBeenCalledWith(cid, block, 1);
  });

  it("ack after tip advance emits ack event", async () => {
    const cid = await fakeCid(4);
    const block = fakeBlock(4);

    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(block),
      decodeBlock: vi.fn().mockReturnValue({
        seq: 1,
      }),
      getBlock: vi.fn().mockReturnValue(block),
      applySnapshot: vi.fn().mockResolvedValue({
        seq: 1,
      }),
    });

    const ac = new AbortController();
    const { input, done } = wirePipeline(effects, ac);

    // First: discover and apply tip
    input.push({
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });

    await settle(100);

    // Then: receive ack for that CID
    input.push({
      type: "ack-received",
      ts: 2,
      cid,
      peerId: "pinner-1",
    });

    await settle();
    ac.abort();
    await done;

    expect(effects.emitAck).toHaveBeenCalled();
    const call = (effects.emitAck as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(cid);
    // ackedBy should be a Set containing "pinner-1"
    expect(call[1]).toBeInstanceOf(Set);
    expect([...call[1]]).toContain("pinner-1");
  });

  it(
    "chain walk: fetched block with prev discovers " + "parent CID",
    async () => {
      const cid = await fakeCid(5);
      const prevCid = await fakeCid(50);
      const block = fakeBlock(5);

      const effects = mockEffects({
        fetchBlock: vi.fn().mockResolvedValue(block),
        decodeBlock: vi.fn().mockReturnValue({
          seq: 2,
          prev: prevCid,
        }),
        getBlock: vi.fn().mockReturnValue(block),
        applySnapshot: vi.fn().mockResolvedValue({
          seq: 2,
        }),
      });

      const ac = new AbortController();
      const { input, done } = wirePipeline(effects, ac);

      input.push({
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "gossipsub",
      });

      await settle(100);
      ac.abort();
      await done;

      // Block for original CID was resolved (via
      // local cache fast path or async fetch)
      expect(effects.decodeBlock).toHaveBeenCalled();
      // prev CID discovered via chain-walk should
      // also be resolved — either via fast path
      // (getBlock returns cached block) or async
      // fetch. Since getBlock returns a block for
      // all CIDs in this test, the fast path fires
      // for both, meaning decodeBlock is called for
      // both CIDs.
      const decodeCalls = (effects.decodeBlock as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(decodeCalls.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("multiple fact sources merge correctly", async () => {
    const cid1 = await fakeCid(6);
    const cid2 = await fakeCid(7);

    const effects = mockEffects();
    const ac = new AbortController();
    const { input, done } = wirePipeline(effects, ac);

    // Push facts from different "sources"
    input.push({
      type: "gossip-subscribed",
      ts: 1,
    });
    input.push({
      type: "cid-discovered",
      ts: 2,
      cid: cid1,
      source: "gossipsub",
    });
    input.push({
      type: "cid-discovered",
      ts: 3,
      cid: cid2,
      source: "ipns",
    });

    await settle();
    ac.abort();
    await done;

    // Both CIDs should trigger fetch (both are
    // auto-fetch sources)
    expect(effects.fetchBlock).toHaveBeenCalledTimes(2);
    // Gossip subscription should trigger status
    // emission
    expect(effects.emitGossipActivity).toHaveBeenCalled();
  });
});
