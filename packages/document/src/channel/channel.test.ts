import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import type { Measured } from "@pokapali/finger-tree";
import { toArray } from "@pokapali/finger-tree";
import type { Codec } from "@pokapali/codec";
import type { Epoch } from "#history";
import { Edit } from "#history";
import { View } from "../view.js";
import * as State from "#state";
import { Channel } from "./channel.js";

// -- Helpers --

function fakeEdit(
  id: number,
  author = "aabb",
  channel = "content",
  timestamp = Date.now(),
) {
  return Edit.create({
    payload: new Uint8Array([id]),
    timestamp,
    author,
    channel,
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

function fakeCodec(): Codec {
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
    createSurface() {
      throw new Error("not implemented");
    },
    clockSum() {
      return 0;
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

describe("Channel.create", () => {
  it("starts with a single empty open epoch", () => {
    const ch = Channel.create("content");
    expect(ch.name).toBe("content");

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(0);
    expect(epochs[0]!.boundary.tag).toBe("open");
  });

  it("appendEdit puts edit in the tip epoch", () => {
    const ch = Channel.create("content");
    const e = fakeEdit(1);
    ch.appendEdit(e);

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(1);
    expect(epochs[0]!.edits[0]!.payload).toEqual(new Uint8Array([1]));
  });

  it("multiple appends stay in same open epoch", () => {
    const ch = Channel.create("content");
    ch.appendEdit(fakeEdit(1));
    ch.appendEdit(fakeEdit(2));
    ch.appendEdit(fakeEdit(3));

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(3);
  });

  it("closeEpoch closes tip and opens new epoch", () => {
    const ch = Channel.create("content");
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
    const ch = Channel.create("content");
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

    const ch = Channel.create("content");
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

    const ch = Channel.create("content");
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
    const ch = Channel.create("content");
    const feed = ch.activate(editCountView);

    const cb = vi.fn();
    feed.subscribe(cb);

    ch.destroy();
    ch.appendEdit(fakeEdit(1));

    // No notifications after destroy
    expect(cb).not.toHaveBeenCalled();
  });

  it("closeEpoch on empty tip creates empty closed epoch", () => {
    const ch = Channel.create("content");
    ch.closeEpoch();

    const epochs = toArray(ch.tree);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.boundary.tag).toBe("closed");
    expect(epochs[0]!.edits).toHaveLength(0);
    expect(epochs[1]!.boundary.tag).toBe("open");
    expect(epochs[1]!.edits).toHaveLength(0);
  });

  describe("appendSnapshot", () => {
    it("closes current epoch, appends snapshot epoch, opens fresh", () => {
      const ch = Channel.create("content");
      ch.appendEdit(fakeEdit(1));

      const state = new Uint8Array([99]);
      ch.appendSnapshot(state);

      const epochs = toArray(ch.tree);
      // 3 epochs: closed original, closed snapshot,
      // fresh open
      expect(epochs).toHaveLength(3);
      expect(epochs[0]!.boundary.tag).toBe("closed");
      expect(epochs[0]!.edits).toHaveLength(1);

      expect(epochs[1]!.boundary.tag).toBe("closed");
      expect(epochs[1]!.edits).toHaveLength(1);
      expect(epochs[1]!.edits[0]!.payload).toEqual(state);
      expect(epochs[1]!.edits[0]!.author).toBe("snapshot");
      expect(epochs[1]!.edits[0]!.origin).toBe("hydrate");

      expect(epochs[2]!.boundary.tag).toBe("open");
      expect(epochs[2]!.edits).toHaveLength(0);
    });

    it("works on empty channel", () => {
      const ch = Channel.create("content");
      ch.appendSnapshot(new Uint8Array([42]));

      const epochs = toArray(ch.tree);
      expect(epochs).toHaveLength(3);
      // First epoch is the closed empty original
      expect(epochs[0]!.edits).toHaveLength(0);
      expect(epochs[0]!.boundary.tag).toBe("closed");
      // Snapshot epoch
      expect(epochs[1]!.edits).toHaveLength(1);
      expect(epochs[1]!.edits[0]!.payload).toEqual(new Uint8Array([42]));
      // Fresh open epoch
      expect(epochs[2]!.boundary.tag).toBe("open");
    });

    it("edits after snapshot go into fresh epoch", () => {
      const ch = Channel.create("content");
      ch.appendSnapshot(new Uint8Array([10]));
      ch.appendEdit(fakeEdit(5));

      const epochs = toArray(ch.tree);
      expect(epochs).toHaveLength(3);
      // Last epoch has the new edit
      expect(epochs[2]!.edits).toHaveLength(1);
      expect(epochs[2]!.edits[0]!.payload).toEqual(new Uint8Array([5]));
    });

    it("notifies view subscribers", () => {
      const codec = fakeCodec();
      const view = State.view(codec);
      const ch = Channel.create("content");
      const feed = ch.activate(view);

      const cb = vi.fn();
      feed.subscribe(cb);

      ch.appendSnapshot(new Uint8Array([7]));
      expect(cb).toHaveBeenCalled();
    });
  });

  it("deactivate mid-lifecycle, re-activate gets current", () => {
    const codec = fakeCodec();
    const view = State.view(codec);

    const ch = Channel.create("content");
    const feed1 = ch.activate(view);

    ch.appendEdit(fakeEdit(1));
    ch.appendEdit(fakeEdit(2));

    ch.deactivate("merged-payload");

    ch.appendEdit(fakeEdit(3));

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
    const arbOps = fc.array(
      fc.oneof(
        {
          weight: 3,
          arbitrary: fc.constant("append" as const),
        },
        {
          weight: 1,
          arbitrary: fc.constant("close" as const),
        },
      ),
      { minLength: 1, maxLength: 50 },
    );

    fc.assert(
      fc.property(arbOps, (ops) => {
        const ch = Channel.create("content");
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

        const epochs = toArray(ch.tree);
        const totalEdits = epochs.reduce((sum, ep) => sum + ep.edits.length, 0);
        expect(totalEdits).toBe(appendCount);

        const last = epochs[epochs.length - 1]!;
        expect(last.boundary.tag).toBe("open");
      }),
      { numRuns: 200 },
    );
  });

  it("appendSnapshot tree invariants hold after every op", () => {
    const arbOps = fc.array(
      fc.oneof(
        {
          weight: 4,
          arbitrary: fc.constant("append" as const),
        },
        {
          weight: 1,
          arbitrary: fc.constant("close" as const),
        },
        {
          weight: 1,
          arbitrary: fc.constant("snapshot" as const),
        },
      ),
      { minLength: 1, maxLength: 50 },
    );

    fc.assert(
      fc.property(arbOps, (ops) => {
        const ch = Channel.create("content");
        let appendCount = 0;
        let closeCount = 0;
        let snapshotCount = 0;
        let nextId = 1;

        function checkInvariants() {
          const epochs = toArray(ch.tree);

          // Last epoch is always open
          const last = epochs[epochs.length - 1]!;
          expect(last.boundary.tag).toBe("open");

          // All non-last epochs are closed
          for (let i = 0; i < epochs.length - 1; i++) {
            expect(epochs[i]!.boundary.tag).toBe("closed");
          }

          // Total edits = appends + snapshots
          // (each snapshot adds one synthetic edit)
          const totalEdits = epochs.reduce(
            (sum, ep) => sum + ep.edits.length,
            0,
          );
          expect(totalEdits).toBe(appendCount + snapshotCount);

          // Epoch count:
          //   start with 1
          //   each closeEpoch adds 1
          //   each appendSnapshot adds 2 (close
          //   current + snapshot epoch + fresh open,
          //   net +2 since it replaces the old open)
          expect(epochs.length).toBe(1 + closeCount + 2 * snapshotCount);
        }

        for (const op of ops) {
          switch (op) {
            case "append":
              ch.appendEdit(fakeEdit(nextId++));
              appendCount++;
              break;
            case "close":
              ch.closeEpoch();
              closeCount++;
              break;
            case "snapshot":
              ch.appendSnapshot(new Uint8Array([nextId++]));
              snapshotCount++;
              break;
          }
          checkInvariants();
        }
      }),
      { numRuns: 200 },
    );
  });
});
