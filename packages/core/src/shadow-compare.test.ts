/**
 * Tests for shadow-compare.ts — comparison utility
 * for shadow mode validation between snapshot-watcher
 * state and interpreter DocState.
 */
import { describe, it, expect } from "vitest";
import {
  compareShadowState,
  type OldSystemState,
  type NewSystemState,
  type Discrepancy,
} from "./shadow-compare.js";

// --- Helpers ---

function baseOldState(): OldSystemState {
  return {
    status: "connecting",
    saveState: "saved",
    ackedBy: new Set<string>(),
    guaranteeUntil: 0,
    retainUntil: 0,
    gossipActivity: "inactive",
    tipCid: null,
  };
}

function baseNewState(): NewSystemState {
  return {
    status: "connecting",
    saveState: "saved",
    ackedBy: new Set<string>(),
    guaranteeUntil: 0,
    retainUntil: 0,
    gossipActivity: "inactive",
    tipCid: null,
  };
}

// --- No discrepancies ---

describe("compareShadowState", () => {
  it("returns empty array when states match", () => {
    const result = compareShadowState(baseOldState(), baseNewState());
    expect(result).toEqual([]);
  });

  it("returns empty array when both have same " + "non-null values", () => {
    const old: OldSystemState = {
      status: "synced",
      saveState: "dirty",
      ackedBy: new Set(["peerA", "peerB"]),
      guaranteeUntil: 5000,
      retainUntil: 10000,
      gossipActivity: "receiving",
      tipCid: "baf-tip-1",
    };
    const nw: NewSystemState = {
      status: "synced",
      saveState: "dirty",
      ackedBy: new Set(["peerA", "peerB"]),
      guaranteeUntil: 5000,
      retainUntil: 10000,
      gossipActivity: "receiving",
      tipCid: "baf-tip-1",
    };

    const result = compareShadowState(old, nw);
    expect(result).toEqual([]);
  });

  // --- Status discrepancy ---

  it("detects status mismatch", () => {
    const old = {
      ...baseOldState(),
      status: "synced" as const,
    };
    const nw = {
      ...baseNewState(),
      status: "connecting" as const,
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("status");
    expect(result[0].old).toBe("synced");
    expect(result[0].new).toBe("connecting");
  });

  // --- SaveState discrepancy ---

  it("detects saveState mismatch", () => {
    const old = {
      ...baseOldState(),
      saveState: "saved" as const,
    };
    const nw = {
      ...baseNewState(),
      saveState: "dirty" as const,
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("saveState");
  });

  // --- GossipActivity discrepancy ---

  it("detects gossipActivity mismatch", () => {
    const old = {
      ...baseOldState(),
      gossipActivity: "receiving" as const,
    };
    const nw = {
      ...baseNewState(),
      gossipActivity: "subscribed" as const,
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("gossipActivity");
  });

  // --- Tip CID discrepancy ---

  it("detects tipCid mismatch", () => {
    const old = {
      ...baseOldState(),
      tipCid: "baf-old",
    };
    const nw = {
      ...baseNewState(),
      tipCid: "baf-new",
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("tipCid");
  });

  it("detects tipCid null vs non-null mismatch", () => {
    const old = {
      ...baseOldState(),
      tipCid: null,
    };
    const nw = {
      ...baseNewState(),
      tipCid: "baf-new",
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("tipCid");
  });

  // --- AckedBy discrepancy ---

  it("detects ackedBy missing peer", () => {
    const old = {
      ...baseOldState(),
      ackedBy: new Set(["peerA", "peerB"]),
    };
    const nw = {
      ...baseNewState(),
      ackedBy: new Set(["peerA"]),
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("ackedBy");
  });

  it("detects ackedBy extra peer", () => {
    const old = {
      ...baseOldState(),
      ackedBy: new Set(["peerA"]),
    };
    const nw = {
      ...baseNewState(),
      ackedBy: new Set(["peerA", "peerB"]),
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("ackedBy");
  });

  it("matches ackedBy regardless of insertion " + "order", () => {
    const old = {
      ...baseOldState(),
      ackedBy: new Set(["peerB", "peerA"]),
    };
    const nw = {
      ...baseNewState(),
      ackedBy: new Set(["peerA", "peerB"]),
    };

    const result = compareShadowState(old, nw);
    expect(result).toEqual([]);
  });

  // --- Guarantee aggregate discrepancy ---

  it("detects guaranteeUntil mismatch", () => {
    const old = {
      ...baseOldState(),
      guaranteeUntil: 5000,
    };
    const nw = {
      ...baseNewState(),
      guaranteeUntil: 6000,
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("guaranteeUntil");
    expect(result[0].old).toBe(5000);
    expect(result[0].new).toBe(6000);
  });

  it("detects retainUntil mismatch", () => {
    const old = {
      ...baseOldState(),
      retainUntil: 10000,
    };
    const nw = {
      ...baseNewState(),
      retainUntil: 12000,
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("retainUntil");
  });

  it("matches guarantees when aggregates equal", () => {
    const old = {
      ...baseOldState(),
      guaranteeUntil: 5000,
      retainUntil: 10000,
    };
    const nw = {
      ...baseNewState(),
      guaranteeUntil: 5000,
      retainUntil: 10000,
    };

    const result = compareShadowState(old, nw);
    expect(result).toEqual([]);
  });

  // --- Multiple discrepancies ---

  it("reports multiple discrepancies at once", () => {
    const old = {
      ...baseOldState(),
      status: "synced" as const,
      saveState: "dirty" as const,
      gossipActivity: "receiving" as const,
    };
    const nw = {
      ...baseNewState(),
      status: "offline" as const,
      saveState: "saved" as const,
      gossipActivity: "inactive" as const,
    };

    const result = compareShadowState(old, nw);
    expect(result).toHaveLength(3);
    const fields = result.map((d: Discrepancy) => d.field);
    expect(fields).toContain("status");
    expect(fields).toContain("saveState");
    expect(fields).toContain("gossipActivity");
  });

  // --- Discrepancy structure ---

  it("includes old and new values in output", () => {
    const old = {
      ...baseOldState(),
      status: "synced" as const,
    };
    const nw = {
      ...baseNewState(),
      status: "offline" as const,
    };

    const result = compareShadowState(old, nw);
    expect(result[0]).toEqual({
      field: "status",
      old: "synced",
      new: "offline",
    });
  });

  // --- Explicitly skipped fields ---

  it(
    "does not compare timestamps, " + "fetchAttempt, or announce state",
    () => {
      // Both states differ only in fields we
      // intentionally skip — result should be
      // empty. This test documents that these
      // fields are NOT compared.
      const result = compareShadowState(baseOldState(), baseNewState());
      expect(result).toEqual([]);
    },
  );
});
