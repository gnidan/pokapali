import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import type { Measured } from "@pokapali/finger-tree";
import { toArray } from "@pokapali/finger-tree";
import { edit } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import type { CrdtCodec } from "../codec/codec.js";
import { View, State } from "@pokapali/document";
import { createChannel } from "./channel.js";

// -- Helpers --

function fakeEdit(
  id: number,
  author = "aabb",
  channel = "content",
  timestamp = Date.now(),
) {
  return edit({
    payload: new Uint8Array([id]),
    timestamp,
    author,
    channel,
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

function fakeCodec(): CrdtCodec {
  return {
    merge: (a, b) => {
      const combined = new Uint8Array([...a, ...b]);
      combined.sort();
      return combined;
    },
    diff: (state, base) => {
      const baseSet = new Set(base);
      return new Uint8Array([...state].filter((b) => !baseSet.has(b)));
    },
    apply: (base, update) => {
      const combined = new Uint8Array([...base, ...update]);
      combined.sort();
      return combined;
    },
    empty: () => new Uint8Array([]),
    contains: (snapshot, editPayload) => {
      const id = editPayload[0]!;
      for (const b of snapshot) {
        if (b === id) return true;
      }
      return false;
    },
  };
}

const editCountMeasured: Measured<number, Epoch> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (ep) => ep.edits.length,
};

const editCountView = View.singleChannel({
  name: "edit-count",
  description: "Total edit count",
  channel: "content",
  measured: editCountMeasured,
});

// -- Tests --

describe("createChannel", () => {
  it("starts with a single empty open epoch", () => {
    const ch = createChannel("content");
    expect(ch.name).toBe("content");

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(0);
    expect(epochs[0]!.boundary.tag).toBe("open");
  });

  it("appendEdit puts edit in the tip epoch", () => {
    const ch = createChannel("content");
    const e = fakeEdit(1);
    ch.appendEdit(e);

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(1);
    expect(epochs[0]!.edits[0]!.payload).toEqual(new Uint8Array([1]));
  });

  it("multiple appends stay in same open epoch", () => {
    const ch = createChannel("content");
    ch.appendEdit(fakeEdit(1));
    ch.appendEdit(fakeEdit(2));
    ch.appendEdit(fakeEdit(3));

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(3);
  });

  it("closeEpoch closes tip and opens new epoch", () => {
    const ch = createChannel("content");
    ch.appendEdit(fakeEdit(1));
    ch.closeEpoch();

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.boundary.tag).toBe("closed");
    expect(epochs[0]!.edits).toHaveLength(1);
    expect(epochs[1]!.boundary.tag).toBe("open");
    expect(epochs[1]!.edits).toHaveLength(0);
  });

  it("appendEdit after closeEpoch goes into new epoch", () => {
    const ch = createChannel("content");
    ch.appendEdit(fakeEdit(1));
    ch.closeEpoch();
    ch.appendEdit(fakeEdit(2));

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.edits).toHaveLength(1);
    expect(epochs[1]!.edits).toHaveLength(1);
    expect(epochs[1]!.edits[0]!.payload).toEqual(new Uint8Array([2]));
  });

  it("view activation tracks edits via feed", () => {
    const codec = fakeCodec();
    const view = State.view(codec);

    const ch = createChannel("content");
    const feed = ch.activate(view);

    // Initially empty
    let state = feed.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toEqual(new Uint8Array([]));
    }

    // Append edits, feed should update
    const cb = vi.fn();
    feed.subscribe(cb);

    ch.appendEdit(fakeEdit(1));

    // stale + ready = 2 notifications
    expect(cb).toHaveBeenCalledTimes(2);

    state = feed.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toEqual(new Uint8Array([1]));
    }

    ch.appendEdit(fakeEdit(2));
    state = feed.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toEqual(new Uint8Array([1, 2]));
    }
  });

  it("view correct after closeEpoch — no edits lost", () => {
    const codec = fakeCodec();
    const view = State.view(codec);

    const ch = createChannel("content");
    const feed = ch.activate(view);

    ch.appendEdit(fakeEdit(1));
    ch.appendEdit(fakeEdit(2));
    ch.closeEpoch();
    ch.appendEdit(fakeEdit(3));

    const state = feed.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toEqual(new Uint8Array([1, 2, 3]));
    }
  });

  it("destroy stops view updates", () => {
    const ch = createChannel("content");
    const feed = ch.activate(editCountView);

    const cb = vi.fn();
    feed.subscribe(cb);

    ch.destroy();
    ch.appendEdit(fakeEdit(1));

    // No notifications after destroy
    expect(cb).not.toHaveBeenCalled();
  });

  it("closeEpoch on empty tip creates empty closed epoch", () => {
    const ch = createChannel("content");
    ch.closeEpoch();

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.boundary.tag).toBe("closed");
    expect(epochs[0]!.edits).toHaveLength(0);
    expect(epochs[1]!.boundary.tag).toBe("open");
    expect(epochs[1]!.edits).toHaveLength(0);
  });

  it("deactivate mid-lifecycle, re-activate gets current value", () => {
    const codec = fakeCodec();
    const view = State.view(codec);

    const ch = createChannel("content");
    const feed1 = ch.activate(view);

    ch.appendEdit(fakeEdit(1));
    ch.appendEdit(fakeEdit(2));

    // Deactivate
    ch.deactivate("merged-payload");

    // Append more while deactivated
    ch.appendEdit(fakeEdit(3));

    // Re-activate — fresh feed should have current value
    const feed2 = ch.activate(view);
    expect(feed2).not.toBe(feed1);

    const state = feed2.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toEqual(new Uint8Array([1, 2, 3]));
    }
  });
});

// -- Property tests --

describe("Channel mutation property", () => {
  it("N appends + M closeEpochs → total edits = N", () => {
    // Generate a sequence of operations:
    // "append" or "close"
    const arbOps = fc.array(
      fc.oneof(
        { weight: 3, arbitrary: fc.constant("append" as const) },
        { weight: 1, arbitrary: fc.constant("close" as const) },
      ),
      { minLength: 1, maxLength: 50 },
    );

    fc.assert(
      fc.property(arbOps, (ops) => {
        const ch = createChannel("content");
        let appendCount = 0;
        let nextId = 1;

        for (const op of ops) {
          if (op === "append") {
            ch.appendEdit(fakeEdit(nextId++));
            appendCount++;
          } else {
            ch.closeEpoch();
          }
        }

        // Total edits across all epochs = appendCount
        const epochs = toArray(ch.tree);
        const totalEdits = epochs.reduce((sum, ep) => sum + ep.edits.length, 0);
        expect(totalEdits).toBe(appendCount);

        // Last epoch is always open
        const last = epochs[epochs.length - 1]!;
        expect(last.boundary.tag).toBe("open");
      }),
      { numRuns: 200 },
    );
  });
});
