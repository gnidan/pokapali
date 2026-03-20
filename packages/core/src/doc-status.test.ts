import { describe, it, expect } from "vitest";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
import { statusLabel, saveLabel, deriveLoadingState } from "./doc-status.js";
import {
  initialDocState,
  INITIAL_CHAIN,
  EMPTY_SET,
  EMPTY_GUARANTEES,
} from "./facts.js";
import type { ChainEntry, DocState } from "./facts.js";
import { MAX_INTERPRETER_RETRIES } from "./interpreter.js";

async function fakeCid(n: number): Promise<CID> {
  const bytes = dagCbor.encode({ n });
  const hash = await sha256.digest(bytes);
  return CID.createV1(dagCbor.code, hash);
}

const IDENTITY = {
  ipnsName: "test",
  role: "writer" as const,
  channels: ["ch"],
  appId: "app",
};

function baseState(): DocState {
  return initialDocState(IDENTITY);
}

function makeEntry(cid: CID, overrides: Partial<ChainEntry> = {}): ChainEntry {
  return {
    cid,
    discoveredVia: new Set(["gossipsub"]),
    blockStatus: "unknown",
    fetchAttempt: 0,
    guarantees: EMPTY_GUARANTEES,
    ackedBy: EMPTY_SET,
    ...overrides,
  };
}

describe("statusLabel", () => {
  it("maps every DocStatus to a string", () => {
    expect(statusLabel("synced")).toBe("Live");
    expect(statusLabel("receiving")).toBe("Subscribed");
    expect(statusLabel("connecting")).toBe("Connecting");
    expect(statusLabel("offline")).toBe("Offline");
  });
});

describe("saveLabel", () => {
  it("maps every SaveState to a string", () => {
    expect(saveLabel("saved")).toBe("Published");
    expect(saveLabel("unpublished")).toBe("Publish now");
    expect(saveLabel("saving")).toBe("Saving\u2026");
    expect(saveLabel("dirty")).toBe("Publish changes");
    expect(saveLabel("save-error")).toBe("Save failed");
  });
});

describe("deriveLoadingState", () => {
  it("returns idle for initial state", () => {
    expect(deriveLoadingState(baseState())).toEqual({ status: "idle" });
  });

  it("returns resolving when IPNS is resolving", () => {
    const state = baseState();
    state.ipnsStatus = {
      phase: "resolving",
      startedAt: 1000,
    };
    expect(deriveLoadingState(state)).toEqual({
      status: "resolving",
      startedAt: 1000,
    });
  });

  it("returns fetching when a block is being fetched", async () => {
    const cid = await fakeCid(1);
    const state = baseState();
    const entries = new Map<string, ChainEntry>();
    entries.set(
      cid.toString(),
      makeEntry(cid, {
        blockStatus: "fetching",
        fetchStartedAt: 2000,
      }),
    );
    state.chain = { ...INITIAL_CHAIN, entries };
    expect(deriveLoadingState(state)).toEqual({
      status: "fetching",
      cid: cid.toString(),
      startedAt: 2000,
    });
  });

  it(
    "returns retrying when a block failed but " + "has retries left",
    async () => {
      const cid = await fakeCid(2);
      const state = baseState();
      const entries = new Map<string, ChainEntry>();
      entries.set(
        cid.toString(),
        makeEntry(cid, {
          blockStatus: "failed",
          fetchAttempt: 1,
          lastError: "not found",
        }),
      );
      state.chain = { ...INITIAL_CHAIN, entries };
      const result = deriveLoadingState(state);
      expect(result.status).toBe("retrying");
      if (result.status === "retrying") {
        expect(result.cid).toBe(cid.toString());
        expect(result.attempt).toBe(1);
      }
    },
  );

  it("returns failed when retries exhausted", async () => {
    const cid = await fakeCid(3);
    const state = baseState();
    const entries = new Map<string, ChainEntry>();
    entries.set(
      cid.toString(),
      makeEntry(cid, {
        blockStatus: "failed",
        fetchAttempt: MAX_INTERPRETER_RETRIES,
        lastError: "timeout",
      }),
    );
    state.chain = { ...INITIAL_CHAIN, entries };
    expect(deriveLoadingState(state)).toEqual({
      status: "failed",
      cid: cid.toString(),
      error: "timeout",
    });
  });

  it(
    "returns resolving (not idle) when IPNS " +
      "resolved but block not yet fetched (#38)",
    async () => {
      const cid = await fakeCid(4);
      const state = baseState();
      state.ipnsStatus = {
        phase: "resolved",
        cid,
        at: 3000,
      };
      const entries = new Map<string, ChainEntry>();
      entries.set(cid.toString(), makeEntry(cid, { blockStatus: "unknown" }));
      state.chain = { ...INITIAL_CHAIN, entries };
      expect(deriveLoadingState(state)).toEqual({
        status: "resolving",
        startedAt: 3000,
      });
    },
  );

  it(
    "returns idle when IPNS resolved and all " + "blocks are fetched/applied",
    async () => {
      const cid = await fakeCid(5);
      const state = baseState();
      state.ipnsStatus = {
        phase: "resolved",
        cid,
        at: 3000,
      };
      const entries = new Map<string, ChainEntry>();
      entries.set(
        cid.toString(),
        makeEntry(cid, {
          blockStatus: "applied",
        }),
      );
      state.chain = { ...INITIAL_CHAIN, entries };
      expect(deriveLoadingState(state)).toEqual({ status: "idle" });
    },
  );

  it("returns idle when IPNS resolved with " + "no chain entries", () => {
    const state = baseState();
    // resolved but entries is empty — nothing to
    // wait for
    state.ipnsStatus = {
      phase: "resolved",
      cid: null as unknown as CID,
      at: 3000,
    };
    expect(deriveLoadingState(state)).toEqual({ status: "idle" });
  });
});
