/**
 * Tests for facts.ts — type exports, initial state
 * constants, and derived view projections.
 *
 * Includes all cases from core's tests plus
 * additional edge cases for versionHistory and
 * bestGuarantee projections.
 */
import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  initialDocState,
  versionHistory,
  deriveVersionHistory,
  deriveVersionHistoryFromSnapshots,
  bestGuarantee,
  isGuaranteeActive,
  CLOCK_SKEW_TOLERANCE_MS,
  INITIAL_CHAIN,
  INITIAL_SNAPSHOT_HISTORY,
} from "./facts.js";
import type { ChainState, ChainEntry, SnapshotHistory } from "./facts.js";
import { deriveStatus, deriveSaveState } from "./reducers.js";

async function fakeCid(n: number): Promise<CID> {
  const hash = await sha256.digest(new Uint8Array([n]));
  return CID.createV1(0x71, hash);
}

function fakeEntry(cid: CID, overrides?: Partial<ChainEntry>): ChainEntry {
  return {
    cid,
    discoveredVia: new Set(["gossipsub"]),
    blockStatus: "unknown",
    fetchAttempt: 0,
    guarantees: new Map(),
    ackedBy: new Set(),
    ...overrides,
  };
}

describe("initialDocState", () => {
  it(
    "initial state derives offline status " + "and unpublished save state",
    () => {
      const state = initialDocState({
        ipnsName: "test",
        role: "writer",
        channels: ["content"],
        appId: "app1",
      });
      // Exercise downstream derivation functions
      // rather than asserting raw defaults
      expect(deriveStatus(state.connectivity)).toBe("offline");
      expect(deriveSaveState(state.content, state.chain)).toBe("unpublished");
      // Version history is empty from initial chain
      expect(versionHistory(state.chain)).toEqual([]);
    },
  );
});

describe("versionHistory", () => {
  it("returns empty for empty chain", () => {
    expect(versionHistory(INITIAL_CHAIN)).toEqual([]);
  });

  it("filters entries without seq", async () => {
    const cid = await fakeCid(1);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([[cid.toString(), fakeEntry(cid)]]),
    };
    expect(versionHistory(chain)).toEqual([]);
  });

  it("returns entries with seq, sorted descending", async () => {
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cidA.toString(),
          fakeEntry(cidA, {
            seq: 1,
            ts: 100,
            blockStatus: "fetched",
          }),
        ],
        [
          cidB.toString(),
          fakeEntry(cidB, {
            seq: 3,
            ts: 300,
            blockStatus: "applied",
          }),
        ],
      ]),
    };
    const history = versionHistory(chain);
    expect(history).toHaveLength(2);
    expect(history[0]!.seq).toBe(3);
    expect(history[0]!.available).toBe(true);
    expect(history[1]!.seq).toBe(1);
    expect(history[1]!.available).toBe(true);
  });

  it("marks unknown/fetching/failed as unavailable", async () => {
    const cid = await fakeCid(1);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cid.toString(),
          fakeEntry(cid, {
            seq: 1,
            blockStatus: "unknown",
          }),
        ],
      ]),
    };
    const history = versionHistory(chain);
    expect(history[0]!.available).toBe(false);
  });

  it("treats applied as available", async () => {
    const cid = await fakeCid(1);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cid.toString(),
          fakeEntry(cid, {
            seq: 1,
            ts: 1000,
            blockStatus: "applied",
          }),
        ],
      ]),
    };
    const history = versionHistory(chain);
    expect(history[0]!.available).toBe(true);
  });

  it("handles mixed available and unavailable", async () => {
    const cidA = await fakeCid(10);
    const cidB = await fakeCid(11);
    const cidC = await fakeCid(12);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cidA.toString(),
          fakeEntry(cidA, {
            seq: 1,
            blockStatus: "applied",
          }),
        ],
        [
          cidB.toString(),
          fakeEntry(cidB, {
            seq: 2,
            blockStatus: "unknown",
          }),
        ],
        [
          cidC.toString(),
          fakeEntry(cidC, {
            seq: 3,
            blockStatus: "fetched",
          }),
        ],
      ]),
    };
    const history = versionHistory(chain);
    expect(history).toHaveLength(3);
    // seq 3 (fetched) → available
    expect(history[0]!.available).toBe(true);
    // seq 2 (unknown) → unavailable
    expect(history[1]!.available).toBe(false);
    // seq 1 (applied) → available
    expect(history[2]!.available).toBe(true);
  });
});

describe("bestGuarantee", () => {
  it("returns zeros for empty chain", () => {
    expect(bestGuarantee(INITIAL_CHAIN)).toEqual({
      guaranteeUntil: 0,
      retainUntil: 0,
    });
  });

  it("finds best across multiple entries", async () => {
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cidA.toString(),
          fakeEntry(cidA, {
            guarantees: new Map([
              [
                "pinner1",
                {
                  guaranteeUntil: 1000,
                  retainUntil: 2000,
                },
              ],
            ]),
          }),
        ],
        [
          cidB.toString(),
          fakeEntry(cidB, {
            guarantees: new Map([
              [
                "pinner2",
                {
                  guaranteeUntil: 3000,
                  retainUntil: 1500,
                },
              ],
            ]),
          }),
        ],
      ]),
    };
    expect(bestGuarantee(chain)).toEqual({
      guaranteeUntil: 3000,
      retainUntil: 2000,
    });
  });

  it("handles entries with no guarantees", async () => {
    const cid = await fakeCid(20);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([[cid.toString(), fakeEntry(cid)]]),
    };
    expect(bestGuarantee(chain)).toEqual({
      guaranteeUntil: 0,
      retainUntil: 0,
    });
  });
});

describe("CLOCK_SKEW_TOLERANCE_MS", () => {
  it("is 5 minutes", () => {
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });
});

describe("isGuaranteeActive", () => {
  it("returns true when guarantee is in the future", () => {
    const now = Date.now();
    expect(isGuaranteeActive(now + 60_000, now)).toBe(true);
  });

  it("returns false when guarantee expired", () => {
    const now = Date.now();
    expect(isGuaranteeActive(now - 600_000, now)).toBe(false);
  });

  it("returns true within tolerance window", () => {
    const now = Date.now();
    // Expired 3 min ago — within 5 min tolerance
    expect(isGuaranteeActive(now - 3 * 60_000, now)).toBe(true);
  });

  it("returns false beyond tolerance window", () => {
    const now = Date.now();
    // Expired 6 min ago — beyond 5 min tolerance
    expect(isGuaranteeActive(now - 6 * 60_000, now)).toBe(false);
  });

  it("returns false for zero timestamp", () => {
    expect(isGuaranteeActive(0, Date.now())).toBe(false);
  });

  it("uses Date.now() when now not provided", () => {
    // Far future — should be active
    expect(isGuaranteeActive(Date.now() + 3_600_000)).toBe(true);
  });
});

describe("deriveVersionHistory", () => {
  it("returns empty for null chain", () => {
    const h = deriveVersionHistory(null);
    expect(h.entries).toEqual([]);
    expect(h.walking).toBe(false);
  });

  it("returns empty for initial chain", () => {
    const h = deriveVersionHistory(INITIAL_CHAIN);
    expect(h.entries).toEqual([]);
    expect(h.walking).toBe(false);
  });

  it("includes entries with seq, sorted desc", async () => {
    const cidA = await fakeCid(30);
    const cidB = await fakeCid(31);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cidA.toString(),
          fakeEntry(cidA, {
            seq: 1,
            ts: 100,
            blockStatus: "applied",
          }),
        ],
        [
          cidB.toString(),
          fakeEntry(cidB, {
            seq: 3,
            ts: 300,
            blockStatus: "fetched",
          }),
        ],
      ]),
    };
    const h = deriveVersionHistory(chain);
    expect(h.entries).toHaveLength(2);
    expect(h.entries[0]!.seq).toBe(3);
    expect(h.entries[0]!.status).toBe("available");
    expect(h.entries[1]!.seq).toBe(1);
    expect(h.entries[1]!.status).toBe("available");
    expect(h.walking).toBe(false);
  });

  it("maps blockStatus to status correctly", async () => {
    const cidA = await fakeCid(40);
    const cidB = await fakeCid(41);
    const cidC = await fakeCid(42);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cidA.toString(),
          fakeEntry(cidA, {
            seq: 3,
            blockStatus: "fetched",
          }),
        ],
        [
          cidB.toString(),
          fakeEntry(cidB, {
            seq: 2,
            blockStatus: "unknown",
          }),
        ],
        [
          cidC.toString(),
          fakeEntry(cidC, {
            seq: 1,
            blockStatus: "failed",
          }),
        ],
      ]),
    };
    const h = deriveVersionHistory(chain);
    expect(h.entries[0]!.status).toBe("available");
    expect(h.entries[1]!.status).toBe("loading");
    expect(h.entries[2]!.status).toBe("failed");
  });

  it("sets walking=true when unknown entries", async () => {
    const cid = await fakeCid(50);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cid.toString(),
          fakeEntry(cid, {
            seq: 1,
            blockStatus: "unknown",
          }),
        ],
      ]),
    };
    const h = deriveVersionHistory(chain);
    expect(h.walking).toBe(true);
  });

  it("sets walking=true when fetching entries", async () => {
    const cid = await fakeCid(51);
    const chain: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cid.toString(),
          fakeEntry(cid, {
            seq: 1,
            blockStatus: "fetching",
          }),
        ],
      ]),
    };
    const h = deriveVersionHistory(chain);
    expect(h.walking).toBe(true);
  });

  it("merges interpreter + local chain", async () => {
    const cidA = await fakeCid(60);
    const cidB = await fakeCid(61);
    const interpreter: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cidA.toString(),
          fakeEntry(cidA, {
            seq: 1,
            ts: 100,
            blockStatus: "applied",
          }),
        ],
      ]),
    };
    const local: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [cidA.toString(), fakeEntry(cidA, { seq: 1, ts: 100 })],
        [
          cidB.toString(),
          fakeEntry(cidB, {
            seq: 2,
            ts: 200,
            blockStatus: "fetched",
          }),
        ],
      ]),
    };
    const h = deriveVersionHistory(interpreter, local);
    expect(h.entries).toHaveLength(2);
    // cidB only in local chain
    expect(h.entries[0]!.seq).toBe(2);
    // cidA from interpreter (authoritative)
    expect(h.entries[1]!.seq).toBe(1);
    expect(h.entries[1]!.status).toBe("available");
  });

  it("interpreter chain takes precedence", async () => {
    const cid = await fakeCid(70);
    const interpreter: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cid.toString(),
          fakeEntry(cid, {
            seq: 1,
            blockStatus: "applied",
          }),
        ],
      ]),
    };
    const local: ChainState = {
      ...INITIAL_CHAIN,
      entries: new Map([
        [
          cid.toString(),
          fakeEntry(cid, {
            seq: 1,
            blockStatus: "fetched",
          }),
        ],
      ]),
    };
    const h = deriveVersionHistory(interpreter, local);
    expect(h.entries).toHaveLength(1);
    // Should use interpreter status, not local
    expect(h.entries[0]!.status).toBe("available");
  });
});

describe("deriveVersionHistoryFromSnapshots", () => {
  it("returns empty for empty history", () => {
    const h = deriveVersionHistoryFromSnapshots(INITIAL_SNAPSHOT_HISTORY);
    expect(h.entries).toEqual([]);
    expect(h.walking).toBe(false);
  });

  it("maps records to entries", async () => {
    const cid = await fakeCid(200);
    const history: SnapshotHistory = {
      records: [
        {
          cid,
          seq: 5,
          ts: 1000,
          channel: "content",
          epochIndex: 2,
        },
      ],
    };
    const h = deriveVersionHistoryFromSnapshots(history);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]!.cid).toEqual(cid);
    expect(h.entries[0]!.seq).toBe(5);
    expect(h.entries[0]!.ts).toBe(1000);
    expect(h.entries[0]!.status).toBe("available");
    expect(h.walking).toBe(false);
  });

  it("preserves newest-first order", async () => {
    const cid1 = await fakeCid(201);
    const cid2 = await fakeCid(202);
    const history: SnapshotHistory = {
      records: [
        {
          cid: cid2,
          seq: 10,
          ts: 2000,
          channel: "content",
          epochIndex: 3,
        },
        {
          cid: cid1,
          seq: 5,
          ts: 1000,
          channel: "content",
          epochIndex: 1,
        },
      ],
    };
    const h = deriveVersionHistoryFromSnapshots(history);
    expect(h.entries).toHaveLength(2);
    expect(h.entries[0]!.seq).toBe(10);
    expect(h.entries[1]!.seq).toBe(5);
  });

  it("all entries are available", async () => {
    const cid = await fakeCid(203);
    const history: SnapshotHistory = {
      records: [
        {
          cid,
          seq: 1,
          ts: 500,
          channel: "content",
          epochIndex: 0,
        },
      ],
    };
    const h = deriveVersionHistoryFromSnapshots(history);
    for (const e of h.entries) {
      expect(e.status).toBe("available");
    }
  });
});
