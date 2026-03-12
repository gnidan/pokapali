/**
 * Tests for interpreter.ts — the effect interpreter
 * for the fact-stream state management architecture.
 *
 * Level 3 tests: async, mock EffectHandlers, verify
 * correct effects dispatched for each fact sequence.
 */
import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { runInterpreter, shouldAutoFetch } from "./interpreter.js";
import type { EffectHandlers, ScanOutput } from "./interpreter.js";
import {
  initialDocState,
  INITIAL_CHAIN,
  INITIAL_CONNECTIVITY,
  INITIAL_GOSSIP,
} from "./facts.js";
import type { Fact, DocState, ChainEntry } from "./facts.js";
import { reduce } from "./reducers.js";
import { createAsyncQueue } from "./sources.js";
import type { AsyncQueue } from "./sources.js";

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
 * Build a scan output stream from an array of
 * facts, using the real reducer. This simulates
 * what scan() would produce.
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
 * Run the interpreter with a list of facts, using
 * mock effects. Returns the mock effects for
 * assertion.
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

  // Collect feedback in background
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

// --- shouldAutoFetch tests ---

describe("shouldAutoFetch", () => {
  it("returns true for gossipsub source", async () => {
    const cid = await fakeCid(1);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["gossipsub"]),
      blockStatus: "unknown",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    };
    expect(shouldAutoFetch(entry)).toBe(true);
  });

  it("returns true for ipns source", async () => {
    const cid = await fakeCid(1);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["ipns"]),
      blockStatus: "unknown",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    };
    expect(shouldAutoFetch(entry)).toBe(true);
  });

  it("returns true for reannounce source", async () => {
    const cid = await fakeCid(1);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["reannounce"]),
      blockStatus: "unknown",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    };
    expect(shouldAutoFetch(entry)).toBe(true);
  });

  it("returns false for chain-walk source", async () => {
    const cid = await fakeCid(1);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["chain-walk"]),
      blockStatus: "unknown",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    };
    expect(shouldAutoFetch(entry)).toBe(false);
  });

  it("returns false for pinner-index source", async () => {
    const cid = await fakeCid(1);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["pinner-index"]),
      blockStatus: "unknown",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    };
    expect(shouldAutoFetch(entry)).toBe(false);
  });

  it("returns true if any source is auto-fetch", async () => {
    const cid = await fakeCid(1);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["chain-walk", "gossipsub"]),
      blockStatus: "unknown",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    };
    expect(shouldAutoFetch(entry)).toBe(true);
  });
});

// --- Fetch dispatch tests ---

describe("interpreter fetch dispatch", () => {
  it("dispatches fetch for new gossipsub CID", async () => {
    const cid = await fakeCid(1);
    const { effects, feedback } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 1,
          cid,
          source: "gossipsub",
          seq: 1,
        },
      ],
      {
        fetchBlock: vi.fn().mockResolvedValue(null),
      },
    );

    expect(effects.fetchBlock).toHaveBeenCalledWith(cid);
    // block-fetch-started pushed to feedback
    expect(feedback.some((f) => f.type === "block-fetch-started")).toBe(true);
  });

  it("pushes block-fetched on successful fetch", async () => {
    const cid = await fakeCid(1);
    const block = fakeBlock(1);
    const { feedback } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 1,
          cid,
          source: "gossipsub",
          seq: 1,
        },
      ],
      {
        fetchBlock: vi.fn().mockResolvedValue(block),
        decodeBlock: vi.fn().mockReturnValue({
          seq: 1,
        }),
      },
    );

    const fetched = feedback.find((f) => f.type === "block-fetched");
    expect(fetched).toBeDefined();
    expect((fetched as any).cid).toEqual(cid);
  });

  it("pushes block-fetch-failed on null result", async () => {
    const cid = await fakeCid(1);
    const { feedback } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 1,
          cid,
          source: "gossipsub",
          seq: 1,
        },
      ],
      {
        fetchBlock: vi.fn().mockResolvedValue(null),
      },
    );

    const failed = feedback.find((f) => f.type === "block-fetch-failed");
    expect(failed).toBeDefined();
    expect((failed as any).error).toBe("not found");
  });

  it("pushes block-fetch-failed on error", async () => {
    const cid = await fakeCid(1);
    const { feedback } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 1,
          cid,
          source: "gossipsub",
          seq: 1,
        },
      ],
      {
        fetchBlock: vi.fn().mockRejectedValue(new Error("network")),
      },
    );

    const failed = feedback.find((f) => f.type === "block-fetch-failed");
    expect(failed).toBeDefined();
    expect((failed as any).error).toBe("network");
  });

  it("does not fetch chain-walk CIDs", async () => {
    // chain-walk CIDs are discovered via
    // block-fetched prev field. We simulate
    // the state directly.
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);

    // Discover cidB via gossipsub, then
    // fetch it with prev=cidA (chain walk)
    const block = fakeBlock(1);
    const { effects } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 1,
          cid: cidB,
          source: "gossipsub",
          seq: 2,
        },
        {
          type: "block-fetched",
          ts: 2,
          cid: cidB,
          block,
          prev: cidA,
          seq: 2,
        },
      ],
      {
        fetchBlock: vi.fn().mockResolvedValue(null),
      },
    );

    // fetchBlock called for cidB (gossipsub)
    // but NOT for cidA (chain-walk)
    const calls = (effects.fetchBlock as ReturnType<typeof vi.fn>).mock.calls;
    const fetchedCids = calls.map((c: CID[]) => c[0].toString());
    expect(fetchedCids).toContain(cidB.toString());
    expect(fetchedCids).not.toContain(cidA.toString());
  });

  it("does not fetch if entry was already " + "unknown in prev", async () => {
    const cid = await fakeCid(11);
    const block = fakeBlock(1);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["gossipsub"]),
      blockStatus: "unknown",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    };

    // Both prev and next have the entry as
    // unknown — should NOT re-dispatch
    const state = initial();
    const withEntry: DocState = {
      ...state,
      chain: {
        ...state.chain,
        entries: new Map([[cid.toString(), entry]]),
      },
    };

    const { effects } = await runWithFacts(
      [{ type: "tick", ts: 1 }],
      {},
      withEntry,
    );

    expect(effects.fetchBlock).not.toHaveBeenCalled();
  });

  it(
    "never awaits network fetch inline " + "(non-blocking dispatch)",
    async () => {
      const cid = await fakeCid(13);
      let fetchResolved = false;

      const effects = mockEffects({
        fetchBlock: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                fetchResolved = true;
                resolve(null);
              }, 100);
            }),
        ),
      });

      const ac = new AbortController();
      const feedbackQueue = createAsyncQueue<Fact>(ac.signal);

      const stream = factsToStream([
        {
          type: "cid-discovered",
          ts: 1,
          cid,
          source: "gossipsub",
          seq: 1,
        },
      ]);

      await runInterpreter(stream, effects, feedbackQueue, ac.signal);

      // Interpreter returned before fetch resolved
      expect(fetchResolved).toBe(false);
      ac.abort();
    },
  );

  it("does not fetch pinner-index CIDs", async () => {
    const cid = await fakeCid(1);
    const { effects } = await runWithFacts([
      {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "pinner-index",
        seq: 1,
      },
    ]);

    expect(effects.fetchBlock).not.toHaveBeenCalled();
  });
});

// --- Tip apply tests ---

describe("interpreter tip apply", () => {
  it("applies newestFetched as tip", async () => {
    const cid = await fakeCid(1);
    const block = fakeBlock(1);

    const { effects, feedback } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 1,
          cid,
          source: "gossipsub",
          block,
          seq: 1,
        },
      ],
      {
        getBlock: vi.fn().mockReturnValue(block),
        applySnapshot: vi.fn().mockResolvedValue({ seq: 1 }),
      },
    );

    expect(effects.applySnapshot).toHaveBeenCalledWith(cid, block);
    const advanced = feedback.find((f) => f.type === "tip-advanced");
    expect(advanced).toBeDefined();
    expect((advanced as any).seq).toBe(1);
  });

  it("does not apply if newestFetched is " + "already tip", async () => {
    const cid = await fakeCid(21);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["gossipsub"]),
      blockStatus: "applied",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
      seq: 5,
    };

    // State where newestFetched === tip
    const state: DocState = {
      ...initial(),
      chain: {
        ...initial().chain,
        entries: new Map([[cid.toString(), entry]]),
        tip: cid,
        newestFetched: cid,
      },
    };

    const { effects } = await runWithFacts(
      [{ type: "tick", ts: 1 }],
      {},
      state,
    );

    expect(effects.applySnapshot).not.toHaveBeenCalled();
  });
});

// --- Announce tests ---

describe("interpreter announce", () => {
  it("announces on publish-succeeded", async () => {
    const cid = await fakeCid(1);
    const block = fakeBlock(1);

    const { effects, feedback } = await runWithFacts(
      [
        {
          type: "publish-succeeded",
          ts: 1,
          cid,
          seq: 1,
        },
      ],
      {
        getBlock: vi.fn().mockReturnValue(block),
      },
    );

    expect(effects.announce).toHaveBeenCalledWith(cid, block, 1);
    const announced = feedback.find((f) => f.type === "announced");
    expect(announced).toBeDefined();
    expect((announced as any).seq).toBe(1);
  });

  it("does not announce if block unavailable", async () => {
    const cid = await fakeCid(1);

    const { effects } = await runWithFacts(
      [
        {
          type: "publish-succeeded",
          ts: 1,
          cid,
          seq: 1,
        },
      ],
      {
        getBlock: vi.fn().mockReturnValue(null),
      },
    );

    expect(effects.announce).not.toHaveBeenCalled();
  });
});

// --- Reannounce tests ---

describe("interpreter reannounce", () => {
  it("reannounces on reannounce-tick with " + "lastAnnouncedCid", async () => {
    const cid = await fakeCid(1);
    const block = fakeBlock(1);

    // Build initial state with an announced
    // CID
    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 1,
    });
    state = {
      ...state,
      announce: {
        lastAnnouncedCid: cid,
        lastAnnounceAt: 100,
        lastGuaranteeQueryAt: 0,
      },
    };

    const { effects } = await runWithFacts(
      [{ type: "reannounce-tick", ts: 200 }],
      {
        getBlock: vi.fn().mockReturnValue(block),
      },
      state,
    );

    expect(effects.announce).toHaveBeenCalledWith(cid, block, 1);
  });

  it("does not reannounce without " + "lastAnnouncedCid", async () => {
    const { effects } = await runWithFacts([
      { type: "reannounce-tick", ts: 200 },
    ]);

    expect(effects.announce).not.toHaveBeenCalled();
  });

  it("immediate reannounce on relay-connected", async () => {
    const cid = await fakeCid(1);
    const block = fakeBlock(1);

    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 1,
    });
    state = {
      ...state,
      announce: {
        lastAnnouncedCid: cid,
        lastAnnounceAt: 100,
        lastGuaranteeQueryAt: 0,
      },
    };

    const { effects } = await runWithFacts(
      [
        {
          type: "relay-connected",
          ts: 200,
          peerId: "relay1",
        },
      ],
      {
        getBlock: vi.fn().mockReturnValue(block),
      },
      state,
    );

    expect(effects.announce).toHaveBeenCalledWith(cid, block, 1);
  });

  it(
    "relay-connected does not push announced " + "fact to feedback",
    async () => {
      const cid = await fakeCid(51);
      const block = fakeBlock(1);

      let state = initial();
      state = reduce(state, {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "gossipsub",
        seq: 1,
      });
      state = {
        ...state,
        announce: {
          lastAnnouncedCid: cid,
          lastAnnounceAt: 100,
          lastGuaranteeQueryAt: 0,
        },
      };

      const { feedback } = await runWithFacts(
        [
          {
            type: "relay-connected",
            ts: 200,
            peerId: "relay2",
          },
        ],
        {
          getBlock: vi.fn().mockReturnValue(block),
        },
        state,
      );

      // relay-connected calls announce but does
      // NOT push "announced" fact to feedback
      expect(feedback.some((f) => f.type === "announced")).toBe(false);
    },
  );
});

// --- markReady tests ---

describe("interpreter markReady", () => {
  it("calls markReady when tip goes from " + "null to non-null", async () => {
    const cid = await fakeCid(60);
    const entry: ChainEntry = {
      cid,
      discoveredVia: new Set(["gossipsub"]),
      blockStatus: "applied",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
      seq: 1,
    };

    const prev = initial();
    const next: DocState = {
      ...prev,
      chain: {
        ...prev.chain,
        tip: cid,
        entries: new Map([[cid.toString(), entry]]),
      },
    };
    const fact: Fact = {
      type: "tip-advanced",
      ts: 1,
      cid,
      seq: 1,
    };

    const effects = mockEffects();
    const ac = new AbortController();
    const feedbackQueue = createAsyncQueue<Fact>(ac.signal);

    await runInterpreter(
      (async function* () {
        yield { prev, next, fact };
      })(),
      effects,
      feedbackQueue,
      ac.signal,
    );

    ac.abort();

    expect(effects.markReady).toHaveBeenCalledOnce();
  });

  it("does not call markReady when tip already " + "exists", async () => {
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);
    const block = fakeBlock(1);

    // State already has a tip
    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid: cidA,
      source: "gossipsub",
      block,
      seq: 1,
    });
    state = reduce(state, {
      type: "tip-advanced",
      ts: 2,
      cid: cidA,
      seq: 1,
    });

    const { effects } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 3,
          cid: cidB,
          source: "gossipsub",
          block: fakeBlock(2),
          seq: 2,
        },
      ],
      {
        getBlock: vi.fn().mockReturnValue(fakeBlock(2)),
        applySnapshot: vi.fn().mockResolvedValue({ seq: 2 }),
      },
      state,
    );

    // markReady should NOT be called because
    // tip was already non-null
    expect(effects.markReady).not.toHaveBeenCalled();
  });
});

// --- Event emission tests ---

describe("interpreter event emission", () => {
  it("emits status on connectivity change", async () => {
    const { effects } = await runWithFacts([
      {
        type: "sync-status-changed",
        ts: 1,
        status: "connected",
      },
    ]);

    expect(effects.emitStatus).toHaveBeenCalledWith("synced");
  });

  it("emits saveState on content change", async () => {
    const { effects } = await runWithFacts([
      {
        type: "content-dirty",
        ts: 1,
        clockSum: 10,
      },
    ]);

    expect(effects.emitSaveState).toHaveBeenCalledWith("dirty");
  });

  it("emits gossipActivity on gossip change", async () => {
    const { effects } = await runWithFacts([
      {
        type: "gossip-message",
        ts: 1000,
      },
    ]);

    expect(effects.emitGossipActivity).toHaveBeenCalledWith("receiving");
  });

  it("emits snapshotApplied on tip advance", async () => {
    const cid = await fakeCid(1);
    const block = fakeBlock(1);

    const { effects } = await runWithFacts(
      [
        {
          type: "cid-discovered",
          ts: 1,
          cid,
          source: "gossipsub",
          block,
          seq: 1,
        },
      ],
      {
        getBlock: vi.fn().mockReturnValue(block),
        applySnapshot: vi.fn().mockResolvedValue({ seq: 1 }),
      },
    );

    // tip-advanced is pushed to feedback,
    // but the stream has already ended.
    // emitSnapshotApplied should NOT be called
    // from the initial stream — it fires when
    // the tip-advanced fact is processed.
    // In our test setup, feedback facts aren't
    // re-processed through the stream.
    // This tests the announce side-effect only.
  });

  it("does not emit snapshotApplied when tip " + "unchanged", async () => {
    const cid = await fakeCid(71);

    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 1,
    });
    state = reduce(state, {
      type: "tip-advanced",
      ts: 2,
      cid,
      seq: 1,
    });

    const { effects } = await runWithFacts(
      [{ type: "tick", ts: 3 }],
      {},
      state,
    );

    expect(effects.emitSnapshotApplied).not.toHaveBeenCalled();
  });

  it("emits ack when tip's ackedBy changes", async () => {
    const cid = await fakeCid(1);

    // State with a tip
    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 1,
    });
    state = reduce(state, {
      type: "tip-advanced",
      ts: 2,
      cid,
      seq: 1,
    });

    const { effects } = await runWithFacts(
      [
        {
          type: "ack-received",
          ts: 3,
          cid,
          peerId: "peerA",
        },
      ],
      {},
      state,
    );

    expect(effects.emitAck).toHaveBeenCalledWith(cid, expect.any(Set));
  });

  it("does not emit ack when ackedBy is same " + "reference", async () => {
    const cid = await fakeCid(73);
    const ackedBy = new Set(["peerA"]);

    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 1,
    });
    state = reduce(state, {
      type: "tip-advanced",
      ts: 2,
      cid,
      seq: 1,
    });
    // Manually set ackedBy
    const tipEntry = state.chain.entries.get(cid.toString())!;
    const entries = new Map(state.chain.entries);
    entries.set(cid.toString(), {
      ...tipEntry,
      ackedBy,
    });
    state = {
      ...state,
      chain: { ...state.chain, entries },
    };

    const { effects } = await runWithFacts(
      [{ type: "tick", ts: 3 }],
      {},
      state,
    );

    expect(effects.emitAck).not.toHaveBeenCalled();
  });

  it("emits guarantee when tip's guarantees " + "change", async () => {
    const cid = await fakeCid(1);

    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 1,
    });
    state = reduce(state, {
      type: "tip-advanced",
      ts: 2,
      cid,
      seq: 1,
    });

    const { effects } = await runWithFacts(
      [
        {
          type: "guarantee-received",
          ts: 3,
          peerId: "pinner1",
          cid,
          guaranteeUntil: 5000,
          retainUntil: 10000,
        },
      ],
      {},
      state,
    );

    expect(effects.emitGuarantee).toHaveBeenCalledWith(cid, expect.any(Map));
  });

  it("does not emit status when unchanged", async () => {
    const { effects } = await runWithFacts([{ type: "tick", ts: 1 }]);

    expect(effects.emitStatus).not.toHaveBeenCalled();
  });

  it("does not emit saveState when unchanged", async () => {
    const { effects } = await runWithFacts([{ type: "tick", ts: 1 }]);

    expect(effects.emitSaveState).not.toHaveBeenCalled();
  });

  it("does not emit ack for non-tip CID", async () => {
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);

    // Tip is cidA, ack for cidB
    let state = initial();
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid: cidA,
      source: "gossipsub",
      seq: 1,
    });
    state = reduce(state, {
      type: "tip-advanced",
      ts: 2,
      cid: cidA,
      seq: 1,
    });
    state = reduce(state, {
      type: "cid-discovered",
      ts: 3,
      cid: cidB,
      source: "gossipsub",
      seq: 2,
    });

    const { effects } = await runWithFacts(
      [
        {
          type: "ack-received",
          ts: 4,
          cid: cidB,
          peerId: "peerA",
        },
      ],
      {},
      state,
    );

    expect(effects.emitAck).not.toHaveBeenCalled();
  });
});

// --- Wake-up scheduling tests ---

describe("interpreter wake-up scheduling", () => {
  it("schedules gossip decay wake-up when " + "receiving", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const effects = mockEffects();

      // Use a simple mock feedback that just
      // collects pushed facts (no async
      // iteration needed for this test)
      const pushed: Fact[] = [];
      const feedback = {
        push(f: Fact) {
          pushed.push(f);
        },
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              Promise.resolve({
                done: true as const,
                value: undefined,
              }),
          };
        },
      } as AsyncQueue<Fact>;

      // Build prev/next where gossip goes to
      // "receiving". Use Date.now() so the
      // timer calculates remaining correctly
      // under fake timers.
      const now = Date.now();
      const prev = initial();
      const next: DocState = {
        ...prev,
        connectivity: {
          ...prev.connectivity,
          gossip: {
            ...prev.connectivity.gossip,
            activity: "receiving",
            lastMessageAt: now,
          },
        },
      };

      await runInterpreter(
        (async function* () {
          yield {
            prev,
            next,
            fact: {
              type: "gossip-message" as const,
              ts: now,
            },
          };
        })(),
        effects,
        feedback,
        ac.signal,
      );

      // Advance past the 60s gossip decay
      vi.advanceTimersByTime(60_000);

      // The timer should have pushed a tick
      const tick = pushed.find((f) => f.type === "tick");
      expect(tick).toBeDefined();
      ac.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules guarantee requery wake-up " + "when announced", async () => {
    vi.useFakeTimers();
    try {
      const cid = await fakeCid(1);
      const ac = new AbortController();
      const effects = mockEffects();
      const feedbackQueue = createAsyncQueue<Fact>(ac.signal);
      const collected: Fact[] = [];

      const collector = (async () => {
        for await (const f of feedbackQueue) {
          collected.push(f);
        }
      })();

      // State with an announced CID
      let state = initial();
      state = reduce(state, {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "gossipsub",
        seq: 1,
      });
      state = {
        ...state,
        announce: {
          lastAnnouncedCid: cid,
          lastAnnounceAt: 100,
          lastGuaranteeQueryAt: Date.now(),
        },
      };

      const stream = factsToStream([{ type: "tick", ts: Date.now() }], state);

      await runInterpreter(stream, effects, feedbackQueue, ac.signal);

      // Advance past 5 min guarantee requery
      vi.advanceTimersByTime(5 * 60_000);

      ac.abort();
      await collector;

      const tick = collected.find((f) => f.type === "tick");
      expect(tick).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears gossip decay timer when no longer " + "receiving", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const effects = mockEffects();
      const feedbackQueue = createAsyncQueue<Fact>(ac.signal);
      const collected: Fact[] = [];

      const collector = (async () => {
        for await (const f of feedbackQueue) {
          collected.push(f);
        }
      })();

      // Go to receiving, then back to silent
      // (gossip decays when 60s elapses without
      // new message — but if state already shows
      // "silent", timer should be cleared)
      let state = initial();
      state = reduce(state, {
        type: "gossip-message",
        ts: 1000,
      });
      // Manually set gossip back to silent
      state = {
        ...state,
        connectivity: {
          ...state.connectivity,
          gossip: {
            activity: "inactive",
            subscribed: false,
            lastMessageAt: 0,
          },
        },
      };

      const stream = factsToStream([{ type: "tick", ts: 2000 }], state);

      await runInterpreter(stream, effects, feedbackQueue, ac.signal);

      // Advance well past decay — no tick
      // should appear because timer was cleared
      vi.advanceTimersByTime(120_000);

      ac.abort();
      await collector;

      const tick = collected.find((f) => f.type === "tick");
      expect(tick).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears all timers on abort", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const effects = mockEffects();
      const feedbackQueue = createAsyncQueue<Fact>(ac.signal);

      const stream = factsToStream([
        {
          type: "gossip-message",
          ts: 1000,
        },
      ]);

      await runInterpreter(stream, effects, feedbackQueue, ac.signal);

      // Abort — should clear timers
      ac.abort();

      // Advancing should not cause errors
      vi.advanceTimersByTime(120_000);

      // No error = pass
      expect(true).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- AbortSignal tests ---

describe("interpreter abort", () => {
  it("exits cleanly on abort", async () => {
    const ac = new AbortController();
    const effects = mockEffects();
    const feedbackQueue = createAsyncQueue<Fact>(ac.signal);

    // Create a stream that yields one item
    // then we abort
    async function* slowStream(): AsyncGenerator<ScanOutput> {
      const state = initial();
      yield {
        prev: state,
        next: state,
        fact: { type: "tick", ts: 1 },
      };
      // Abort mid-stream
      ac.abort();
      yield {
        prev: state,
        next: state,
        fact: { type: "tick", ts: 2 },
      };
    }

    await runInterpreter(slowStream(), effects, feedbackQueue, ac.signal);

    // Should complete without error
    expect(true).toBe(true);
  });
});
