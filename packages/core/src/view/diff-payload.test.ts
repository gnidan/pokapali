import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary, openBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import type { CrdtCodec } from "../codec/codec.js";
import { evaluateMonoidal, createCache } from "./evaluate.js";
import { mergedPayloadView } from "./merged-payload.js";
import { evaluateAt } from "./evaluate-at.js";
import { diffPayloadView } from "./diff-payload.js";

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

// -- diffPayloadView tests --

describe("diffPayloadView", () => {
  const codec = fakeCodec();
  const view = diffPayloadView(codec);

  it("has correct metadata", () => {
    expect(view.name).toBe("diff-payload");
    expect(view.description).toContain("diff");
  });

  it("adjacent epochs → diff", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3), fakeEdit(4)], closedBoundary()),
    ]);

    const mergeView = mergedPayloadView(codec);
    const cache = createCache<Uint8Array>();
    const before = evaluateAt(mergeView, tree, 1, cache);
    const after = evaluateAt(mergeView, tree, 2, cache);

    const result = view.compute(tree, { before, after });

    // Diff: bytes in after not in before = [3, 4]
    expect(result).toEqual(new Uint8Array([3, 4]));
  });

  it("first epoch only → diff from empty", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
    ]);

    const mergeView = mergedPayloadView(codec);
    const cache = createCache<Uint8Array>();
    const before = codec.empty();
    const after = evaluateAt(mergeView, tree, 1, cache);

    const result = view.compute(tree, { before, after });

    expect(result).toEqual(new Uint8Array([1, 2]));
  });

  it("empty tree → empty diff", () => {
    const tree = fromEpochs([]);
    const before = codec.empty();
    const after = codec.empty();

    const result = view.compute(tree, { before, after });

    expect(result).toEqual(new Uint8Array([]));
  });

  it("same position → empty diff", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
    ]);

    const mergeView = mergedPayloadView(codec);
    const cache = createCache<Uint8Array>();
    const state = evaluateAt(mergeView, tree, 1, cache);

    const result = view.compute(tree, { before: state, after: state });

    expect(result).toEqual(new Uint8Array([]));
  });

  it("integration: 5-epoch diff at positions", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4)], closedBoundary()),
      epoch([fakeEdit(5)], closedBoundary()),
    ]);

    const mergeView = mergedPayloadView(codec);
    const cache = createCache<Uint8Array>();

    // Diff between position 2 and position 4
    const before = evaluateAt(mergeView, tree, 2, cache);
    const after = evaluateAt(mergeView, tree, 4, cache);

    const result = view.compute(tree, { before, after });

    // Edits 3, 4 are new
    expect(result).toEqual(new Uint8Array([3, 4]));
  });
});

// -- Property tests --

describe("diffPayloadView properties", () => {
  const arbEpoch = fc
    .array(fc.integer({ min: 1, max: 255 }), { minLength: 1, maxLength: 5 })
    .map((ids) =>
      epoch(
        ids.map((id) => fakeEdit(id, "aa", "content", id)),
        closedBoundary(),
      ),
    );

  it("diff(0, N) applied to empty = mergedPayload", () => {
    const codec_ = fakeCodec();

    fc.assert(
      fc.property(
        fc.array(arbEpoch, {
          minLength: 1,
          maxLength: 10,
        }),
        (epochs) => {
          const tree = fromEpochs(epochs);
          const mergeView = mergedPayloadView(codec_);
          const diffView = diffPayloadView(codec_);
          const cache = createCache<Uint8Array>();

          const fullMerge = evaluateMonoidal(mergeView, tree, cache);
          const before = codec_.empty();
          const after = evaluateAt(mergeView, tree, epochs.length, cache);

          const diff = diffView.compute(tree, { before, after });

          // apply(empty, diff(0, N)) should equal
          // mergedPayload of full tree
          const applied = codec_.apply(codec_.empty(), diff);
          expect(applied).toEqual(fullMerge);
        },
      ),
      { numRuns: 100 },
    );
  });
});
