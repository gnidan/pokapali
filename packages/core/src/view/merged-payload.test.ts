import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { snoc, toArray, foldl } from "@pokapali/finger-tree";
import { epochMeasured } from "../epoch/index-monoid.js";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary, openBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import type { CrdtCodec } from "../codec/codec.js";
import { evaluateMonoidal, createCache, seedCache } from "./evaluate.js";
import { mergedPayloadView } from "./merged-payload.js";

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

/**
 * Fake CrdtCodec: merge = concat, empty = [].
 * Commutative up to sort (we sort in merge for
 * deterministic tests).
 */
function fakeCodec(): CrdtCodec {
  return {
    merge: (a, b) => {
      const combined = new Uint8Array([...a, ...b]);
      combined.sort();
      return combined;
    },
    diff: (state, _base) => state,
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

// -- mergedPayloadView tests --

describe("mergedPayloadView", () => {
  it("has correct metadata", () => {
    const codec = fakeCodec();
    const view = mergedPayloadView(codec);

    expect(view.name).toBe("merged-payload");
    expect(view.description).toContain("merge");
  });

  it("empty tree → empty payload", () => {
    const codec = fakeCodec();
    const view = mergedPayloadView(codec);
    const tree = fromEpochs([]);
    const cache = createCache<Uint8Array>();

    const result = evaluateMonoidal(view, tree, cache);

    expect(result).toEqual(new Uint8Array([]));
  });

  it("single epoch merges all edit payloads", () => {
    const codec = fakeCodec();
    const view = mergedPayloadView(codec);
    const tree = fromEpochs([
      epoch([fakeEdit(3), fakeEdit(1), fakeEdit(2)], closedBoundary()),
    ]);
    const cache = createCache<Uint8Array>();

    const result = evaluateMonoidal(view, tree, cache);

    // Sorted concat: [1, 2, 3]
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("multiple epochs merge across boundaries", () => {
    const codec = fakeCodec();
    const view = mergedPayloadView(codec);
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4), fakeEdit(5)], openBoundary()),
    ]);
    const cache = createCache<Uint8Array>();

    const result = evaluateMonoidal(view, tree, cache);

    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("empty epochs contribute nothing", () => {
    const codec = fakeCodec();
    const view = mergedPayloadView(codec);
    const tree = fromEpochs([
      epoch([], closedBoundary()),
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([], openBoundary()),
    ]);
    const cache = createCache<Uint8Array>();

    const result = evaluateMonoidal(view, tree, cache);

    expect(result).toEqual(new Uint8Array([1]));
  });

  it("structural sharing cache test: snoc then re-evaluate", () => {
    const codec = fakeCodec();
    const view = mergedPayloadView(codec);

    const measureSpy = vi.spyOn(view.measured, "measure");

    // Use 8 epochs to ensure internal Node objects
    // exist in the middle spine for structural sharing
    const tree1 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4)], closedBoundary()),
      epoch([fakeEdit(5)], closedBoundary()),
      epoch([fakeEdit(6)], closedBoundary()),
      epoch([fakeEdit(7)], closedBoundary()),
      epoch([fakeEdit(8)], closedBoundary()),
    ]);

    const cache = createCache<Uint8Array>();
    const result1 = evaluateMonoidal(view, tree1, cache);
    expect(result1).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const callsAfterFirst = measureSpy.mock.calls.length;
    expect(callsAfterFirst).toBe(8);

    // Snoc a new epoch — tree shares internal nodes
    // with tree1 (prefix + middle spine)
    measureSpy.mockClear();
    const newEpoch = epoch([fakeEdit(9)], openBoundary());
    const tree2 = snoc(epochMeasured, tree1, newEpoch);

    const result2 = evaluateMonoidal(view, tree2, cache);
    expect(result2).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));

    // Should call measure fewer times than a full
    // re-evaluation because shared subtrees hit cache
    expect(measureSpy.mock.calls.length).toBeLessThan(callsAfterFirst);
  });
});
