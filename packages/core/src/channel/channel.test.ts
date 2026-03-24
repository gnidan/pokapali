import { describe, it, expect, vi } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import { toArray } from "@pokapali/finger-tree";
import { edit, epoch, openBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import type { CrdtCodec } from "../codec/codec.js";
import { monoidalView } from "../view/types.js";
import { mergedPayloadView } from "../view/merged-payload.js";
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

const editCountView = monoidalView({
  name: "edit-count",
  description: "Total edit count",
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
    const view = mergedPayloadView(codec);

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
    const view = mergedPayloadView(codec);

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
});
