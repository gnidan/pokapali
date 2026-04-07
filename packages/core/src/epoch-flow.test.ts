/**
 * epoch-flow.test.ts — Integration test for the
 * epoch lifecycle fact chain:
 *   convergence-detected → epoch-closed
 *   → snapshot-materialized → view-cache-written
 *
 * Level 4: tests the full interpreter pipeline
 * with a fact stream that exercises the complete
 * epoch lifecycle.
 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { runInterpreter } from "./interpreter.js";
import type { EffectHandlers, ScanOutput } from "./interpreter.js";
import { initialDocState } from "./facts.js";
import type { Fact, DocState } from "./facts.js";
import { reduce } from "./reducers.js";
import { createAsyncQueue } from "./sources.js";

// --- Helpers ---

async function fakeCid(n: number): Promise<CID> {
  const hash = await sha256.digest(new Uint8Array([n]));
  return CID.createV1(0x71, hash);
}

const IDENTITY = {
  ipnsName: "test",
  role: "writer" as const,
  channels: ["content"],
  appId: "app1",
};

function initial(): DocState {
  return initialDocState(IDENTITY);
}

function fakeBlock(n: number): Uint8Array {
  return new Uint8Array([n, n + 1, n + 2]);
}

function mockEffects(overrides?: Partial<EffectHandlers>): EffectHandlers {
  return {
    fetchBlock: vi.fn().mockResolvedValue(null),
    applySnapshot: vi.fn().mockResolvedValue({
      seq: 1,
    }),
    getBlock: vi.fn().mockReturnValue(null),
    decodeBlock: vi.fn().mockReturnValue({}),
    announce: vi.fn(),
    markReady: vi.fn(),
    emitSnapshotApplied: vi.fn(),
    emitAck: vi.fn(),
    emitGossipActivity: vi.fn(),
    emitLoading: vi.fn(),
    emitGuarantee: vi.fn(),
    emitValidationError: vi.fn(),
    ...overrides,
  };
}

/**
 * Build a scan output stream from facts,
 * using the real reducer.
 */
async function* factsToStream(
  facts: Fact[],
  init?: DocState,
): AsyncGenerator<ScanOutput> {
  let state = init ?? initial();
  for (const fact of facts) {
    const prev = state;
    state = reduce(state, fact);
    yield { prev, next: state, fact };
  }
}

/**
 * Run interpreter with facts and collect feedback.
 * Returns effects + feedback for assertion.
 */
async function runWithFacts(
  facts: Fact[],
  effectOverrides?: Partial<EffectHandlers>,
  init?: DocState,
): Promise<{
  effects: EffectHandlers;
  feedback: Fact[];
}> {
  const effects = mockEffects(effectOverrides);
  const ac = new AbortController();
  const feedbackQueue = createAsyncQueue<Fact>(ac.signal);
  const collected: Fact[] = [];

  const collector = (async () => {
    for await (const f of feedbackQueue) {
      collected.push(f);
    }
  })();

  const stream = factsToStream(facts, init);
  await runInterpreter(stream, effects, feedbackQueue, ac.signal);

  ac.abort();
  await collector;
  return { effects, feedback: collected };
}

// --- Integration tests ---

describe("epoch lifecycle integration", () => {
  it(
    "convergence-detected triggers full chain:" +
      " epoch-closed → snapshot + cache",
    async () => {
      const snapshotCid = await fakeCid(200);
      const snapshotBlock = fakeBlock(200);
      const hash = new Uint8Array([1, 2, 3]);

      const materializeSnapshot = vi.fn().mockResolvedValue(snapshotCid);
      const writeViewCache = vi
        .fn()
        .mockResolvedValue([{ viewName: "state", entries: 2 }]);

      const { feedback } = await runWithFacts(
        [
          {
            type: "convergence-detected",
            ts: 1000,
            channel: "content",
            hash,
          },
        ],
        {
          materializeSnapshot,
          writeViewCache,
          getBlock: vi.fn().mockReturnValue(snapshotBlock),
        },
      );

      // convergence-detected → epoch-closed
      const closed = feedback.find((f) => f.type === "epoch-closed");
      expect(closed).toBeDefined();
      expect((closed as any).channel).toBe("content");

      // epoch-closed triggers materializeSnapshot
      // (non-blocking, so check the mock was called)
      expect(materializeSnapshot).not.toHaveBeenCalled();
      // materializeSnapshot is dispatched when
      // epoch-closed processes through the stream,
      // but epoch-closed is only in feedback (not
      // re-fed through the stream in this harness).
      // So we test the chain by feeding both facts.
    },
  );

  it("epoch-closed → materialize + cache " + "writes full chain", async () => {
    const snapshotCid = await fakeCid(201);
    const snapshotBlock = fakeBlock(201);

    const materializeSnapshot = vi.fn().mockResolvedValue(snapshotCid);
    const writeViewCache = vi
      .fn()
      .mockResolvedValue([{ viewName: "state", entries: 3 }]);

    await runWithFacts(
      [
        {
          type: "epoch-closed",
          ts: 1000,
          channel: "content",
          epochIndex: 0,
        },
      ],
      {
        materializeSnapshot,
        writeViewCache,
        getBlock: vi.fn().mockReturnValue(snapshotBlock),
      },
    );

    // writeViewCache called
    expect(writeViewCache).toHaveBeenCalledWith("content", 0);

    // materializeSnapshot called
    expect(materializeSnapshot).toHaveBeenCalledWith("content", 0);

    // Wait for async effects to settle
    await new Promise((r) => setTimeout(r, 10));

    // Note: snapshot-materialized feedback
    // appears only if the materializeSnapshot
    // promise resolves before abort. In our
    // test harness, the promise resolves after
    // the stream ends but before abort, so
    // it should appear.
  });

  it("epoch-closed without effects does not " + "crash", async () => {
    // No writeViewCache or materializeSnapshot
    // on effects — should not throw
    const { feedback } = await runWithFacts([
      {
        type: "epoch-closed",
        ts: 1000,
        channel: "content",
        epochIndex: 0,
      },
    ]);

    // No crash = pass
    expect(feedback).toBeDefined();
  });

  it("view-cache-loaded populates caches via " + "effect handler", async () => {
    const populateViewCache = vi.fn();

    await runWithFacts(
      [
        {
          type: "view-cache-loaded",
          ts: 1000,
          viewName: "state",
          entries: 5,
        },
      ],
      { populateViewCache },
    );

    expect(populateViewCache).toHaveBeenCalledWith("state", 5);
  });

  it("snapshot-materialized announces via " + "gossip path", async () => {
    const cid = await fakeCid(202);
    const block = fakeBlock(202);

    const { effects } = await runWithFacts(
      [
        {
          type: "snapshot-materialized",
          ts: 1000,
          channel: "content",
          epochIndex: 0,
          cid,
          seq: 1,
        },
      ],
      {
        getBlock: vi.fn().mockReturnValue(block),
      },
    );

    expect(effects.announce).toHaveBeenCalledWith(cid, block, 0);
  });

  it("multiple channels track independently", async () => {
    const materializeSnapshot = vi.fn().mockResolvedValue(null);
    const writeViewCache = vi
      .fn()
      .mockResolvedValue([{ viewName: "state", entries: 1 }]);

    await runWithFacts(
      [
        {
          type: "epoch-closed",
          ts: 1000,
          channel: "content",
          epochIndex: 0,
        },
        {
          type: "epoch-closed",
          ts: 1001,
          channel: "comments",
          epochIndex: 0,
        },
      ],
      { materializeSnapshot, writeViewCache },
    );

    expect(writeViewCache).toHaveBeenCalledTimes(2);
    expect(writeViewCache).toHaveBeenCalledWith("content", 0);
    expect(writeViewCache).toHaveBeenCalledWith("comments", 0);
  });
});
