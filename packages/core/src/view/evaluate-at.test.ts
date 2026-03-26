import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import type { CrdtCodec } from "../codec/codec.js";
import { evaluateMonoidal, createCache } from "./evaluate.js";
import { mergedPayloadView } from "./merged-payload.js";
import { monoidalView } from "./types.js";
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

// -- Property tests --

describe("evaluateAt properties", () => {
  const arbEpoch = fc
    .array(fc.integer({ min: 1, max: 255 }), {
      minLength: 1,
      maxLength: 5,
    })
    .map((ids) =>
      epoch(
        ids.map((id) => fakeEdit(id, "aa", "content", id)),
        closedBoundary(),
      ),
    );

  it("evaluateAt(view, tree, N) = foldl over first N epochs", () => {
    const codec_ = fakeCodec();
    const mergeView = mergedPayloadView(codec_);

    fc.assert(
      fc.property(
        fc.array(arbEpoch, { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (epochs, position) => {
          const tree = fromEpochs(epochs);
          const cache = createCache<Uint8Array>();

          const actual = evaluateAt(mergeView, tree, position, cache);

          // Manual foldl over first N epochs
          const n = Math.min(position, epochs.length);
          const prefix = epochs.slice(0, n);
          const m = mergeView.channels["content"]!;
          const expected = prefix.reduce((acc, ep) => {
            const epValue = m.measure(ep);
            return m.monoid.append(acc, epValue);
          }, m.monoid.empty);

          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// -- Cache sharing --

describe("evaluateAt cache sharing", () => {
  it("fewer measure calls when cache is warm", () => {
    const measureSpy = vi.fn((ep: Epoch) => ep.edits.length);
    const spiedView = monoidalView({
      name: "spied-count",
      description: "Spied edit count",
      channel: "test",
      measured: {
        monoid: {
          empty: 0,
          append: (a: number, b: number) => a + b,
        },
        measure: measureSpy,
      },
    });

    // 8 epochs for internal node sharing
    const tree = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4)], closedBoundary()),
      epoch([fakeEdit(5)], closedBoundary()),
      epoch([fakeEdit(6)], closedBoundary()),
      epoch([fakeEdit(7)], closedBoundary()),
      epoch([fakeEdit(8)], closedBoundary()),
    ]);

    const cache = createCache<number>();

    // Warm the cache with a full evaluation
    evaluateMonoidal(spiedView, tree, cache);
    const warmCalls = measureSpy.mock.calls.length;
    expect(warmCalls).toBe(8);

    // Now evaluateAt with warm cache
    measureSpy.mockClear();
    const result = evaluateAt(spiedView, tree, 5, cache);

    // Should reuse cached subtree nodes
    expect(measureSpy.mock.calls.length).toBeLessThan(warmCalls);
    expect(result).toBe(5);
  });
});
