import { describe, it, expect } from "vitest";
import { toArray } from "@pokapali/finger-tree";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary, openBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import type { CrdtCodec } from "../codec/codec.js";
import { evaluateMonoidal, createCache } from "./evaluate.js";
import { mergedPayloadView } from "./merged-payload.js";
import { evaluateAt } from "./evaluate-at.js";

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
      // Return bytes in state not in base
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

// -- evaluateAt tests --

describe("evaluateAt", () => {
  const codec = fakeCodec();
  const view = mergedPayloadView(codec);

  it("position 0 → monoid identity", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
    ]);
    const cache = createCache<Uint8Array>();

    const result = evaluateAt(view, tree, 0, cache);

    expect(result).toEqual(new Uint8Array([]));
  });

  it("position 1 → first epoch only", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
    ]);
    const cache = createCache<Uint8Array>();

    const result = evaluateAt(view, tree, 1, cache);

    expect(result).toEqual(new Uint8Array([1, 2]));
  });

  it("position = all epochs → same as evaluateMonoidal", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
    ]);
    const cache = createCache<Uint8Array>();

    const atAll = evaluateAt(view, tree, 3, cache);
    const full = evaluateMonoidal(view, tree, cache);

    expect(atAll).toEqual(full);
  });

  it("position beyond tree size → full evaluation", () => {
    const tree = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);
    const cache = createCache<Uint8Array>();

    const result = evaluateAt(view, tree, 10, cache);
    const full = evaluateMonoidal(view, tree, cache);

    expect(result).toEqual(full);
  });

  it("empty tree → monoid identity", () => {
    const tree = fromEpochs([]);
    const cache = createCache<Uint8Array>();

    const result = evaluateAt(view, tree, 5, cache);

    expect(result).toEqual(new Uint8Array([]));
  });

  it("adjacent epochs → correct prefix sums", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4)], closedBoundary()),
      epoch([fakeEdit(5)], closedBoundary()),
    ]);
    const cache = createCache<Uint8Array>();

    expect(evaluateAt(view, tree, 1, cache)).toEqual(new Uint8Array([1]));
    expect(evaluateAt(view, tree, 2, cache)).toEqual(new Uint8Array([1, 2]));
    expect(evaluateAt(view, tree, 3, cache)).toEqual(new Uint8Array([1, 2, 3]));
    expect(evaluateAt(view, tree, 4, cache)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(evaluateAt(view, tree, 5, cache)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
  });
});
