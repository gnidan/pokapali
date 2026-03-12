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
  bestGuarantee,
  isGuaranteeActive,
  CLOCK_SKEW_TOLERANCE_MS,
  INITIAL_CHAIN,
  INITIAL_CONNECTIVITY,
  INITIAL_CONTENT,
  INITIAL_GOSSIP,
} from "./facts.js";
import type { ChainState, ChainEntry } from "./facts.js";

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
  it("creates correct defaults", () => {
    const state = initialDocState({
      ipnsName: "test",
      role: "writer",
      channels: ["content"],
      appId: "app1",
    });
    expect(state.status).toBe("offline");
    expect(state.saveState).toBe("unpublished");
    expect(state.chain.entries.size).toBe(0);
    expect(state.chain.tip).toBeNull();
    expect(state.connectivity.syncStatus).toBe("disconnected");
    expect(state.content.isDirty).toBe(false);
  });
});

describe("INITIAL constants", () => {
  it("INITIAL_CHAIN has empty entries", () => {
    expect(INITIAL_CHAIN.entries.size).toBe(0);
    expect(INITIAL_CHAIN.tip).toBeNull();
    expect(INITIAL_CHAIN.newestFetched).toBeNull();
  });

  it("INITIAL_CONNECTIVITY is offline", () => {
    expect(INITIAL_CONNECTIVITY.syncStatus).toBe("disconnected");
    expect(INITIAL_CONNECTIVITY.awarenessConnected).toBe(false);
    expect(INITIAL_CONNECTIVITY.relayPeers.size).toBe(0);
  });

  it("INITIAL_GOSSIP is inactive", () => {
    expect(INITIAL_GOSSIP.activity).toBe("inactive");
    expect(INITIAL_GOSSIP.subscribed).toBe(false);
  });

  it("INITIAL_CONTENT is clean", () => {
    expect(INITIAL_CONTENT.isDirty).toBe(false);
    expect(INITIAL_CONTENT.isSaving).toBe(false);
    expect(INITIAL_CONTENT.clockSum).toBe(0);
  });
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
    expect(history[0].seq).toBe(3);
    expect(history[0].available).toBe(true);
    expect(history[1].seq).toBe(1);
    expect(history[1].available).toBe(true);
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
    expect(history[0].available).toBe(false);
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
    expect(history[0].available).toBe(true);
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
    expect(history[0].available).toBe(true);
    // seq 2 (unknown) → unavailable
    expect(history[1].available).toBe(false);
    // seq 1 (applied) → available
    expect(history[2].available).toBe(true);
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
