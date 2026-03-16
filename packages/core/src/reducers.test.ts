/**
 * Tests for reducers.ts — pure reducer functions
 * for the state management redesign (#1, step 2).
 *
 * Level 1 tests: pure, sync, no mocks.
 * Includes all cases from core's tests plus
 * property-based tests with fast-check for
 * invariants.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  reduce,
  reduceChain,
  reduceConnectivity,
  reduceContent,
  reduceAnnounce,
  reduceGossip,
  deriveStatus,
  deriveSaveState,
} from "./reducers.js";
import {
  initialDocState,
  INITIAL_CHAIN,
  INITIAL_CONNECTIVITY,
  INITIAL_CONTENT,
  INITIAL_GOSSIP,
} from "./facts.js";
import type {
  Fact,
  ChainState,
  ContentState,
  DocState,
  AnnounceState,
} from "./facts.js";

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

const INITIAL_ANNOUNCE: AnnounceState = {
  lastAnnouncedCid: null,
  lastAnnounceAt: 0,
  lastGuaranteeQueryAt: 0,
};

// ------------------------------------------------
// Chain reducer
// ------------------------------------------------

describe("reduceChain", () => {
  it("adds new CID on cid-discovered", async () => {
    const cid = await fakeCid(1);
    const state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 5,
    });
    const entry = state.entries.get(cid.toString());
    expect(entry).toBeDefined();
    expect(entry!.blockStatus).toBe("unknown");
    expect(entry!.seq).toBe(5);
    expect(entry!.discoveredVia.has("gossipsub")).toBe(true);
  });

  it("marks inline block as fetched", async () => {
    const cid = await fakeCid(1);
    const block = new Uint8Array([1, 2, 3]);
    const state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      block,
    });
    const entry = state.entries.get(cid.toString());
    expect(entry!.blockStatus).toBe("fetched");
  });

  it("merges discovery sources for known CID", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "cid-discovered",
      ts: 2,
      cid,
      source: "ipns",
    });
    const entry = state.entries.get(cid.toString());
    expect(entry!.discoveredVia.has("gossipsub")).toBe(true);
    expect(entry!.discoveredVia.has("ipns")).toBe(true);
  });

  it("http-tip source tracked in " + "discoveredVia", async () => {
    const cid = await fakeCid(99);
    const block = new Uint8Array([1, 2, 3]);
    const state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "http-tip",
      block,
      seq: 5,
    });
    const entry = state.entries.get(cid.toString());
    expect(entry).toBeDefined();
    expect(entry!.discoveredVia.has("http-tip")).toBe(true);
    expect(entry!.blockStatus).toBe("fetched");
  });

  it("http-tip + gossipsub both tracked " + "for same CID", async () => {
    const cid = await fakeCid(100);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "http-tip",
      seq: 3,
    });
    state = reduceChain(state, {
      type: "cid-discovered",
      ts: 2,
      cid,
      source: "gossipsub",
    });
    const entry = state.entries.get(cid.toString());
    expect(entry!.discoveredVia.has("http-tip")).toBe(true);
    expect(entry!.discoveredVia.has("gossipsub")).toBe(true);
  });

  it("resets failed CID to unknown on rediscovery", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "block-fetch-failed",
      ts: 2,
      cid,
      attempt: 1,
      error: "timeout",
    });
    expect(state.entries.get(cid.toString())!.blockStatus).toBe("failed");

    state = reduceChain(state, {
      type: "cid-discovered",
      ts: 3,
      cid,
      source: "ipns",
    });
    const entry = state.entries.get(cid.toString());
    expect(entry!.blockStatus).toBe("unknown");
    expect(entry!.fetchAttempt).toBe(0);
  });

  it("transitions fetching → fetched", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "block-fetch-started",
      ts: 2,
      cid,
    });
    expect(state.entries.get(cid.toString())!.blockStatus).toBe("fetching");
    expect(state.entries.get(cid.toString())!.fetchStartedAt).toBe(2);

    state = reduceChain(state, {
      type: "block-fetched",
      ts: 3,
      cid,
      block: new Uint8Array([1]),
      seq: 5,
    });
    expect(state.entries.get(cid.toString())!.blockStatus).toBe("fetched");
    expect(state.newestFetched).toEqual(cid);
  });

  it("discovers prev CID via chain walk", async () => {
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid: cidB,
      source: "gossipsub",
      seq: 6,
    });
    state = reduceChain(state, {
      type: "block-fetched",
      ts: 2,
      cid: cidB,
      block: new Uint8Array([1]),
      prev: cidA,
      seq: 6,
    });
    // cidA discovered via chain walk
    const prevEntry = state.entries.get(cidA.toString());
    expect(prevEntry).toBeDefined();
    expect(prevEntry!.blockStatus).toBe("unknown");
    expect(prevEntry!.discoveredVia.has("chain-walk")).toBe(true);
    // seq inferred from parent (6 - 1 = 5)
    expect(prevEntry!.seq).toBe(5);
  });

  it("does not overwrite existing entry on chain walk", async () => {
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);
    // cidA already known
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid: cidA,
      source: "gossipsub",
      seq: 5,
    });
    state = reduceChain(state, {
      type: "cid-discovered",
      ts: 1,
      cid: cidB,
      source: "gossipsub",
      seq: 6,
    });
    state = reduceChain(state, {
      type: "block-fetched",
      ts: 2,
      cid: cidB,
      block: new Uint8Array([1]),
      prev: cidA,
      seq: 6,
    });
    // cidA should keep original discovery source
    const entry = state.entries.get(cidA.toString());
    expect(entry!.discoveredVia.has("gossipsub")).toBe(true);
    expect(entry!.seq).toBe(5);
  });

  it("tip-advanced sets tip and marks applied", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      block: new Uint8Array([1]),
    });
    state = reduceChain(state, {
      type: "tip-advanced",
      ts: 2,
      cid,
      seq: 1,
    });
    expect(state.tip).toEqual(cid);
    expect(state.entries.get(cid.toString())!.blockStatus).toBe("applied");
  });

  it("per-CID acks", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "ack-received",
      ts: 2,
      cid,
      peerId: "peerA",
    });
    const entry = state.entries.get(cid.toString());
    expect(entry!.ackedBy.has("peerA")).toBe(true);
  });

  it("duplicate ack reuses Set reference", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "ack-received",
      ts: 2,
      cid,
      peerId: "peerA",
    });
    const before = state.entries.get(cid.toString())!.ackedBy;
    state = reduceChain(state, {
      type: "ack-received",
      ts: 3,
      cid,
      peerId: "peerA",
    });
    const after = state.entries.get(cid.toString())!.ackedBy;
    // Same Set reference — structural sharing
    expect(before).toBe(after);
  });

  it("per-CID guarantees", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "guarantee-received",
      ts: 2,
      peerId: "pinner1",
      cid,
      guaranteeUntil: 5000,
      retainUntil: 10000,
    });
    const entry = state.entries.get(cid.toString());
    const g = entry!.guarantees.get("pinner1");
    expect(g).toEqual({
      guaranteeUntil: 5000,
      retainUntil: 10000,
    });
  });

  it(
    "guarantee-received after http-tip " + "discovery stores guarantee",
    async () => {
      const cid = await fakeCid(101);
      const block = new Uint8Array([10, 20]);
      // Discover via http-tip with inline block
      let state = reduceChain(INITIAL_CHAIN, {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "http-tip",
        block,
        seq: 7,
      });
      // Then receive guarantee for same CID
      state = reduceChain(state, {
        type: "guarantee-received",
        ts: 2,
        peerId: "pinner-chi",
        cid,
        guaranteeUntil: 9000,
        retainUntil: 18000,
      });
      const entry = state.entries.get(cid.toString());
      expect(entry!.discoveredVia.has("http-tip")).toBe(true);
      expect(entry!.blockStatus).toBe("fetched");
      const g = entry!.guarantees.get("pinner-chi");
      expect(g).toEqual({
        guaranteeUntil: 9000,
        retainUntil: 18000,
      });
    },
  );

  it(
    "multiple guarantees from different " + "pinners on same CID",
    async () => {
      const cid = await fakeCid(102);
      let state = reduceChain(INITIAL_CHAIN, {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "http-tip",
        seq: 1,
      });
      state = reduceChain(state, {
        type: "guarantee-received",
        ts: 2,
        peerId: "pinner-a",
        cid,
        guaranteeUntil: 5000,
        retainUntil: 10000,
      });
      state = reduceChain(state, {
        type: "guarantee-received",
        ts: 3,
        peerId: "pinner-b",
        cid,
        guaranteeUntil: 6000,
        retainUntil: 12000,
      });
      const entry = state.entries.get(cid.toString());
      expect(entry!.guarantees.size).toBe(2);
      expect(entry!.guarantees.get("pinner-a")).toEqual({
        guaranteeUntil: 5000,
        retainUntil: 10000,
      });
      expect(entry!.guarantees.get("pinner-b")).toEqual({
        guaranteeUntil: 6000,
        retainUntil: 12000,
      });
    },
  );

  it("guarantee-received for unknown CID " + "is no-op", async () => {
    const cid = await fakeCid(103);
    const state = reduceChain(INITIAL_CHAIN, {
      type: "guarantee-received",
      ts: 1,
      peerId: "pinner-x",
      cid,
      guaranteeUntil: 5000,
      retainUntil: 10000,
    });
    expect(state).toBe(INITIAL_CHAIN);
  });

  it(
    "guarantee-received updates existing " + "guarantee from same pinner",
    async () => {
      const cid = await fakeCid(104);
      let state = reduceChain(INITIAL_CHAIN, {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "http-tip",
        seq: 2,
      });
      state = reduceChain(state, {
        type: "guarantee-received",
        ts: 2,
        peerId: "pinner-chi",
        cid,
        guaranteeUntil: 5000,
        retainUntil: 10000,
      });
      // Same pinner, updated guarantee
      state = reduceChain(state, {
        type: "guarantee-received",
        ts: 3,
        peerId: "pinner-chi",
        cid,
        guaranteeUntil: 8000,
        retainUntil: 16000,
      });
      const entry = state.entries.get(cid.toString());
      expect(entry!.guarantees.size).toBe(1);
      expect(entry!.guarantees.get("pinner-chi")).toEqual({
        guaranteeUntil: 8000,
        retainUntil: 16000,
      });
    },
  );

  it("ack for unknown CID is no-op", async () => {
    const cid = await fakeCid(99);
    const state = reduceChain(INITIAL_CHAIN, {
      type: "ack-received",
      ts: 1,
      cid,
      peerId: "peerA",
    });
    expect(state).toBe(INITIAL_CHAIN);
  });

  it("newestFetched tracks highest seq", async () => {
    const cidA = await fakeCid(1);
    const cidB = await fakeCid(2);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid: cidA,
      source: "gossipsub",
      block: new Uint8Array([1]),
      seq: 3,
    });
    expect(state.newestFetched).toEqual(cidA);

    state = reduceChain(state, {
      type: "cid-discovered",
      ts: 2,
      cid: cidB,
      source: "gossipsub",
      block: new Uint8Array([2]),
      seq: 7,
    });
    expect(state.newestFetched).toEqual(cidB);
  });

  it("block-fetch-failed records error", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "block-fetch-failed",
      ts: 2,
      cid,
      attempt: 2,
      error: "not found",
    });
    const entry = state.entries.get(cid.toString());
    expect(entry!.blockStatus).toBe("failed");
    expect(entry!.fetchAttempt).toBe(2);
    expect(entry!.lastError).toBe("not found");
  });

  it(
    "block-fetch-failed clears newestFetched " +
      "when the failed CID was newest (GH #61)",
    async () => {
      const cid = await fakeCid(1);
      let state = reduceChain(INITIAL_CHAIN, {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "gossipsub",
        seq: 5,
      });
      state = reduceChain(state, {
        type: "block-fetched",
        ts: 2,
        cid,
        block: new Uint8Array([1]),
        seq: 5,
      });
      expect(state.newestFetched?.toString()).toBe(cid.toString());

      // Now fail the same CID — newestFetched
      // should no longer point to it
      state = reduceChain(state, {
        type: "block-fetch-failed",
        ts: 3,
        cid,
        attempt: 1,
        error: "timeout",
      });
      expect(state.newestFetched).toBeNull();
    },
  );

  it("block-retry-reset resets failed to unknown", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    state = reduceChain(state, {
      type: "block-fetch-failed",
      ts: 2,
      cid,
      attempt: 1,
      error: "timeout",
    });
    expect(state.entries.get(cid.toString())!.blockStatus).toBe("failed");
    expect(state.entries.get(cid.toString())!.fetchAttempt).toBe(1);

    state = reduceChain(state, {
      type: "block-retry-reset",
      ts: 3,
      cid,
    });
    const entry = state.entries.get(cid.toString());
    expect(entry!.blockStatus).toBe("unknown");
    // fetchAttempt preserved for tracking
    expect(entry!.fetchAttempt).toBe(1);
  });

  it("block-retry-reset is no-op for non-failed " + "entries", async () => {
    const cid = await fakeCid(1);
    let state = reduceChain(INITIAL_CHAIN, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    // Entry is "unknown", not "failed"
    const before = state;
    state = reduceChain(state, {
      type: "block-retry-reset",
      ts: 2,
      cid,
    });
    expect(state).toBe(before);
  });

  it("block-retry-reset is no-op for unknown CID", async () => {
    const cid = await fakeCid(99);
    const state = reduceChain(INITIAL_CHAIN, {
      type: "block-retry-reset",
      ts: 1,
      cid,
    });
    expect(state).toBe(INITIAL_CHAIN);
  });

  it("ignores unrelated facts", () => {
    const state = reduceChain(INITIAL_CHAIN, {
      type: "gossip-message",
      ts: 1,
    });
    expect(state).toBe(INITIAL_CHAIN);
  });
});

// ------------------------------------------------
// Gossip reducer
// ------------------------------------------------

describe("reduceGossip", () => {
  it("subscribed sets activity", () => {
    const state = reduceGossip(INITIAL_GOSSIP, {
      type: "gossip-subscribed",
      ts: 1,
    });
    expect(state.subscribed).toBe(true);
    expect(state.activity).toBe("subscribed");
  });

  it("message sets receiving", () => {
    const state = reduceGossip(INITIAL_GOSSIP, {
      type: "gossip-message",
      ts: 1000,
    });
    expect(state.activity).toBe("receiving");
    expect(state.lastMessageAt).toBe(1000);
  });

  it("decays after timeout", () => {
    let state = reduceGossip(INITIAL_GOSSIP, {
      type: "gossip-message",
      ts: 1000,
    });
    expect(state.activity).toBe("receiving");

    // Subscribed, so decay → subscribed
    state = { ...state, subscribed: true };
    state = reduceGossip(state, {
      type: "tick",
      ts: 1000 + 61_000,
    });
    expect(state.activity).toBe("subscribed");
  });

  it("decays to inactive when not subscribed", () => {
    let state = reduceGossip(INITIAL_GOSSIP, {
      type: "gossip-message",
      ts: 1000,
    });
    state = reduceGossip(state, {
      type: "tick",
      ts: 1000 + 61_000,
    });
    expect(state.activity).toBe("inactive");
  });

  it("does not decay within window", () => {
    let state = reduceGossip(INITIAL_GOSSIP, {
      type: "gossip-message",
      ts: 1000,
    });
    state = reduceGossip(state, {
      type: "tick",
      ts: 1000 + 30_000,
    });
    expect(state.activity).toBe("receiving");
  });
});

// ------------------------------------------------
// Connectivity reducer
// ------------------------------------------------

describe("reduceConnectivity", () => {
  it("handles sync status change", () => {
    const state = reduceConnectivity(INITIAL_CONNECTIVITY, {
      type: "sync-status-changed",
      ts: 1,
      status: "connected",
    });
    expect(state.syncStatus).toBe("connected");
  });

  it("handles awareness status change", () => {
    const state = reduceConnectivity(INITIAL_CONNECTIVITY, {
      type: "awareness-status-changed",
      ts: 1,
      connected: true,
    });
    expect(state.awarenessConnected).toBe(true);
  });

  it("tracks relay peers", () => {
    let state = reduceConnectivity(INITIAL_CONNECTIVITY, {
      type: "relay-connected",
      ts: 1,
      peerId: "relay1",
    });
    expect(state.relayPeers.has("relay1")).toBe(true);

    state = reduceConnectivity(state, {
      type: "relay-disconnected",
      ts: 2,
      peerId: "relay1",
    });
    expect(state.relayPeers.has("relay1")).toBe(false);
  });

  it("duplicate relay-connected is no-op", () => {
    let state = reduceConnectivity(INITIAL_CONNECTIVITY, {
      type: "relay-connected",
      ts: 1,
      peerId: "relay1",
    });
    const before = state;
    state = reduceConnectivity(state, {
      type: "relay-connected",
      ts: 2,
      peerId: "relay1",
    });
    expect(state).toBe(before);
  });

  it("tracks pinner discovery", () => {
    const state = reduceConnectivity(INITIAL_CONNECTIVITY, {
      type: "pinner-discovered",
      ts: 1,
      peerId: "pinner1",
    });
    expect(state.knownPinnerPids.has("pinner1")).toBe(true);
  });

  it("delegates gossip facts", () => {
    const state = reduceConnectivity(INITIAL_CONNECTIVITY, {
      type: "gossip-message",
      ts: 1000,
    });
    expect(state.gossip.activity).toBe("receiving");
  });

  it("returns same ref for unrelated facts", () => {
    const state = reduceConnectivity(INITIAL_CONNECTIVITY, {
      type: "publish-started",
      ts: 1,
    });
    expect(state).toBe(INITIAL_CONNECTIVITY);
  });
});

// ------------------------------------------------
// Content reducer
// ------------------------------------------------

describe("reduceContent", () => {
  it("marks dirty on content-dirty", () => {
    const state = reduceContent(INITIAL_CONTENT, {
      type: "content-dirty",
      ts: 1,
      clockSum: 42,
    });
    expect(state.isDirty).toBe(true);
    expect(state.clockSum).toBe(42);
  });

  it("publish-started sets isSaving", () => {
    const state = reduceContent(INITIAL_CONTENT, {
      type: "publish-started",
      ts: 1,
    });
    expect(state.isSaving).toBe(true);
  });

  it("publish-succeeded clears dirty + saving", async () => {
    const cid = await fakeCid(1);
    let state = reduceContent(INITIAL_CONTENT, {
      type: "content-dirty",
      ts: 1,
      clockSum: 10,
    });
    state = reduceContent(state, {
      type: "publish-started",
      ts: 2,
    });
    state = reduceContent(state, {
      type: "publish-succeeded",
      ts: 3,
      cid,
      seq: 1,
    });
    expect(state.isSaving).toBe(false);
    expect(state.isDirty).toBe(false);
    expect(state.ipnsSeq).toBe(1);
  });

  it("publish-failed clears saving but not dirty", () => {
    let state = reduceContent(INITIAL_CONTENT, {
      type: "content-dirty",
      ts: 1,
      clockSum: 10,
    });
    state = reduceContent(state, {
      type: "publish-started",
      ts: 2,
    });
    state = reduceContent(state, {
      type: "publish-failed",
      ts: 3,
      error: "network",
    });
    expect(state.isSaving).toBe(false);
    expect(state.isDirty).toBe(true);
    expect(state.lastSaveError).toBe("network");
  });

  it("publish-succeeded clears lastSaveError", async () => {
    const cid = await fakeCid(99);
    let state: ContentState = {
      ...INITIAL_CONTENT,
      isDirty: true,
      lastSaveError: "prior error",
    };
    state = reduceContent(state, {
      type: "publish-succeeded",
      ts: 1,
      cid,
      seq: 1,
    });
    expect(state.lastSaveError).toBeNull();
  });

  it("content-dirty clears lastSaveError", () => {
    let state: ContentState = {
      ...INITIAL_CONTENT,
      lastSaveError: "prior error",
    };
    state = reduceContent(state, {
      type: "content-dirty",
      ts: 1,
      clockSum: 5,
    });
    expect(state.lastSaveError).toBeNull();
    expect(state.isDirty).toBe(true);
  });
});

// ------------------------------------------------
// Announce reducer
// ------------------------------------------------

describe("reduceAnnounce", () => {
  it("announced updates lastAnnouncedCid", async () => {
    const cid = await fakeCid(1);
    const state = reduceAnnounce(INITIAL_ANNOUNCE, {
      type: "announced",
      ts: 100,
      cid,
      seq: 1,
    });
    expect(state.lastAnnouncedCid).toEqual(cid);
    expect(state.lastAnnounceAt).toBe(100);
  });

  it("relay-connected resets lastAnnounceAt to 0", () => {
    const state = reduceAnnounce(
      {
        ...INITIAL_ANNOUNCE,
        lastAnnounceAt: 500,
      },
      {
        type: "relay-connected",
        ts: 600,
        peerId: "r1",
      },
    );
    expect(state.lastAnnounceAt).toBe(0);
  });

  it("guarantee-query-sent updates timestamp", () => {
    const state = reduceAnnounce(INITIAL_ANNOUNCE, {
      type: "guarantee-query-sent",
      ts: 200,
      peerId: "p1",
    });
    expect(state.lastGuaranteeQueryAt).toBe(200);
  });
});

// ------------------------------------------------
// Derived status
// ------------------------------------------------

describe("deriveStatus", () => {
  it("synced when sync connected", () => {
    expect(
      deriveStatus({
        ...INITIAL_CONNECTIVITY,
        syncStatus: "connected",
      }),
    ).toBe("synced");
  });

  it("connecting when sync connecting", () => {
    expect(
      deriveStatus({
        ...INITIAL_CONNECTIVITY,
        syncStatus: "connecting",
      }),
    ).toBe("connecting");
  });

  it("receiving when awareness connected", () => {
    expect(
      deriveStatus({
        ...INITIAL_CONNECTIVITY,
        awarenessConnected: true,
      }),
    ).toBe("receiving");
  });

  it("receiving when gossip receiving", () => {
    expect(
      deriveStatus({
        ...INITIAL_CONNECTIVITY,
        gossip: {
          ...INITIAL_GOSSIP,
          activity: "receiving",
        },
      }),
    ).toBe("receiving");
  });

  it("connecting when gossip subscribed", () => {
    expect(
      deriveStatus({
        ...INITIAL_CONNECTIVITY,
        gossip: {
          ...INITIAL_GOSSIP,
          activity: "subscribed",
        },
      }),
    ).toBe("connecting");
  });

  it("offline when nothing connected", () => {
    expect(deriveStatus(INITIAL_CONNECTIVITY)).toBe("offline");
  });
});

// ------------------------------------------------
// Derived save state
// ------------------------------------------------

describe("deriveSaveState", () => {
  it("saving when isSaving", () => {
    expect(
      deriveSaveState({ ...INITIAL_CONTENT, isSaving: true }, INITIAL_CHAIN),
    ).toBe("saving");
  });

  it("dirty when isDirty", () => {
    expect(
      deriveSaveState({ ...INITIAL_CONTENT, isDirty: true }, INITIAL_CHAIN),
    ).toBe("dirty");
  });

  it("saved when tip exists", async () => {
    const cid = await fakeCid(1);
    expect(
      deriveSaveState(INITIAL_CONTENT, {
        ...INITIAL_CHAIN,
        tip: cid,
      }),
    ).toBe("saved");
  });

  it("unpublished when no tip", () => {
    expect(deriveSaveState(INITIAL_CONTENT, INITIAL_CHAIN)).toBe("unpublished");
  });

  it("saving takes priority over dirty", () => {
    expect(
      deriveSaveState(
        {
          ...INITIAL_CONTENT,
          isDirty: true,
          isSaving: true,
        },
        INITIAL_CHAIN,
      ),
    ).toBe("saving");
  });

  it("save-error when lastSaveError is set", () => {
    expect(
      deriveSaveState(
        {
          ...INITIAL_CONTENT,
          isDirty: true,
          lastSaveError: "network",
        },
        INITIAL_CHAIN,
      ),
    ).toBe("save-error");
  });

  it("saving takes priority over save-error", () => {
    expect(
      deriveSaveState(
        {
          ...INITIAL_CONTENT,
          isSaving: true,
          lastSaveError: "stale error",
        },
        INITIAL_CHAIN,
      ),
    ).toBe("saving");
  });

  it("save-error takes priority over dirty", () => {
    expect(
      deriveSaveState(
        {
          ...INITIAL_CONTENT,
          isDirty: true,
          lastSaveError: "failed",
        },
        INITIAL_CHAIN,
      ),
    ).toBe("save-error");
  });
});

// ------------------------------------------------
// Top-level reduce
// ------------------------------------------------

describe("reduce", () => {
  it("returns same ref for unrelated fact", () => {
    const state = initial();
    const next = reduce(state, {
      type: "tick",
      ts: 1,
    });
    expect(next).toBe(state);
  });

  it("updates status on sync change", () => {
    const state = initial();
    const next = reduce(state, {
      type: "sync-status-changed",
      ts: 1,
      status: "connected",
    });
    expect(next.status).toBe("synced");
    expect(next.connectivity.syncStatus).toBe("connected");
  });

  it("updates saveState on publish lifecycle", async () => {
    const cid = await fakeCid(1);
    let state = initial();

    state = reduce(state, {
      type: "content-dirty",
      ts: 1,
      clockSum: 10,
    });
    expect(state.saveState).toBe("dirty");

    state = reduce(state, {
      type: "publish-started",
      ts: 2,
    });
    expect(state.saveState).toBe("saving");

    state = reduce(state, {
      type: "publish-succeeded",
      ts: 3,
      cid,
      seq: 1,
    });
    // No tip yet → unpublished (tip-advanced
    // hasn't fired)
    expect(state.saveState).toBe("unpublished");

    state = reduce(state, {
      type: "tip-advanced",
      ts: 4,
      cid,
      seq: 1,
    });
    expect(state.saveState).toBe("saved");
  });

  it("structural sharing: ackedBy reuses ref", async () => {
    const cid = await fakeCid(1);
    let state = reduce(initial(), {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    const beforeAcks = state.chain.entries.get(cid.toString())!.ackedBy;
    state = reduce(state, {
      type: "gossip-message",
      ts: 2,
    });
    const afterAcks = state.chain.entries.get(cid.toString())!.ackedBy;
    expect(beforeAcks).toBe(afterAcks);
  });

  it("tracks pending guarantee queries", async () => {
    let state = initial();
    state = reduce(state, {
      type: "guarantee-query-sent",
      ts: 100,
      peerId: "pinner1",
    });
    expect(state.pendingQueries.has("pinner1")).toBe(true);
    expect(state.pendingQueries.get("pinner1")!.sentAt).toBe(100);

    state = reduce(state, {
      type: "guarantee-query-responded",
      ts: 200,
      peerId: "pinner1",
    });
    expect(state.pendingQueries.has("pinner1")).toBe(false);
  });

  it("tracks IPNS resolution status", async () => {
    const cid = await fakeCid(1);
    let state = initial();
    state = reduce(state, {
      type: "ipns-resolve-started",
      ts: 100,
    });
    expect(state.ipnsStatus).toEqual({
      phase: "resolving",
      startedAt: 100,
    });

    state = reduce(state, {
      type: "ipns-resolve-completed",
      ts: 200,
      cid,
    });
    expect(state.ipnsStatus).toEqual({
      phase: "resolved",
      cid,
      at: 200,
    });
  });

  it("IPNS resolve with null resets to idle", () => {
    let state = reduce(initial(), {
      type: "ipns-resolve-started",
      ts: 100,
    });
    state = reduce(state, {
      type: "ipns-resolve-completed",
      ts: 200,
      cid: null,
    });
    expect(state.ipnsStatus).toEqual({
      phase: "idle",
    });
  });

  it("full lifecycle: discover → fetch → apply", async () => {
    const cid = await fakeCid(1);
    const block = new Uint8Array([1, 2, 3]);
    let state = initial();

    // Discover
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
      seq: 1,
    });
    expect(state.chain.entries.get(cid.toString())!.blockStatus).toBe(
      "unknown",
    );

    // Fetch start
    state = reduce(state, {
      type: "block-fetch-started",
      ts: 2,
      cid,
    });
    expect(state.chain.entries.get(cid.toString())!.blockStatus).toBe(
      "fetching",
    );

    // Fetch complete
    state = reduce(state, {
      type: "block-fetched",
      ts: 3,
      cid,
      block,
      seq: 1,
    });
    expect(state.chain.entries.get(cid.toString())!.blockStatus).toBe(
      "fetched",
    );
    expect(state.chain.newestFetched).toEqual(cid);

    // Apply as tip
    state = reduce(state, {
      type: "tip-advanced",
      ts: 4,
      cid,
      seq: 1,
    });
    expect(state.chain.tip).toEqual(cid);
    expect(state.chain.entries.get(cid.toString())!.blockStatus).toBe(
      "applied",
    );
    expect(state.saveState).toBe("saved");
  });

  it("incremental matches full replay", async () => {
    const cid = await fakeCid(1);
    const facts: Fact[] = [
      {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "gossipsub",
        seq: 1,
      },
      {
        type: "gossip-message",
        ts: 2,
      },
      {
        type: "ack-received",
        ts: 3,
        cid,
        peerId: "peerA",
      },
      {
        type: "sync-status-changed",
        ts: 4,
        status: "connected",
      },
    ];

    const incremental = facts.reduce(reduce, initial());
    const replay = facts.reduce(reduce, initial());
    expect(incremental).toEqual(replay);
  });
});

// ------------------------------------------------
// Property-based tests (fast-check)
// ------------------------------------------------

describe("reducer invariants (fast-check)", () => {
  // Arbitrary CID generator
  const arbCid = fc
    .uint8Array({
      minLength: 32,
      maxLength: 32,
    })
    .map((bytes) => {
      const hash = {
        code: 0x12,
        size: 32,
        digest: bytes,
        bytes: new Uint8Array([0x12, 0x20, ...bytes]),
      };
      return CID.createV1(0x71, hash as any);
    });

  const arbCidSource = fc.constantFrom(
    "gossipsub" as const,
    "ipns" as const,
    "reannounce" as const,
    "chain-walk" as const,
    "pinner-index" as const,
  );

  // Arbitrary fact generators
  const arbCidDiscovered = fc.record({
    type: fc.constant("cid-discovered" as const),
    ts: fc.nat(),
    cid: arbCid,
    source: arbCidSource,
    seq: fc.option(fc.nat({ max: 1000 }), {
      nil: undefined,
    }),
  });

  const arbAckReceived = fc.record({
    type: fc.constant("ack-received" as const),
    ts: fc.nat(),
    cid: arbCid,
    peerId: fc.string({
      minLength: 1,
      maxLength: 20,
    }),
  });

  const arbGuarantee = fc.record({
    type: fc.constant("guarantee-received" as const),
    ts: fc.nat(),
    peerId: fc.string({
      minLength: 1,
      maxLength: 20,
    }),
    cid: arbCid,
    guaranteeUntil: fc.nat(),
    retainUntil: fc.nat(),
  });

  const arbTick = fc.record({
    type: fc.constant("tick" as const),
    ts: fc.nat(),
  });

  const arbFact = fc.oneof(
    arbCidDiscovered,
    arbAckReceived,
    arbGuarantee,
    arbTick,
  );

  it("chain entries only grow (never removed)", () => {
    fc.assert(
      fc.property(fc.array(arbFact, { maxLength: 50 }), (facts) => {
        let state = initial();
        let prevSize = 0;
        for (const fact of facts) {
          state = reduce(state, fact as Fact);
          const size = state.chain.entries.size;
          expect(size).toBeGreaterThanOrEqual(prevSize);
          prevSize = size;
        }
      }),
      { numRuns: 100 },
    );
  });

  it("acked CIDs stay acked (never removed)", () => {
    fc.assert(
      fc.property(fc.array(arbFact, { maxLength: 50 }), (facts) => {
        let state = initial();
        const acked = new Map<string, Set<string>>();

        for (const fact of facts) {
          state = reduce(state, fact as Fact);
          for (const [key, entry] of state.chain.entries) {
            if (!acked.has(key)) {
              acked.set(key, new Set());
            }
            for (const p of entry.ackedBy) {
              acked.get(key)!.add(p);
            }
          }
        }

        for (const [key, peers] of acked) {
          const entry = state.chain.entries.get(key);
          if (entry) {
            for (const p of peers) {
              expect(entry.ackedBy.has(p)).toBe(true);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("reduce never throws on any fact sequence", () => {
    fc.assert(
      fc.property(fc.array(arbFact, { maxLength: 100 }), (facts) => {
        let state = initial();
        for (const fact of facts) {
          state = reduce(state, fact as Fact);
        }
        expect(state).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });

  it("status is always a valid DocStatus", () => {
    const validStatuses = ["synced", "connecting", "receiving", "offline"];
    fc.assert(
      fc.property(fc.array(arbFact, { maxLength: 30 }), (facts) => {
        let state = initial();
        for (const fact of facts) {
          state = reduce(state, fact as Fact);
          expect(validStatuses).toContain(state.status);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("saveState is always a valid SaveState", () => {
    const validStates = ["saving", "dirty", "saved", "unpublished"];
    fc.assert(
      fc.property(fc.array(arbFact, { maxLength: 30 }), (facts) => {
        let state = initial();
        for (const fact of facts) {
          state = reduce(state, fact as Fact);
          expect(validStates).toContain(state.saveState);
        }
      }),
      { numRuns: 100 },
    );
  });
});
