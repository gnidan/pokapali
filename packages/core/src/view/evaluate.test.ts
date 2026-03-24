import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import type { Measured } from "@pokapali/finger-tree";
import { toArray, foldl } from "@pokapali/finger-tree";
import { epochMeasured } from "../epoch/index-monoid.js";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary, openBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import { monoidalView } from "./types.js";
import { evaluateMonoidal, createCache, seedCache } from "./evaluate.js";
import type { ViewCache } from "./evaluate.js";

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
 * Sum monoid: counts total edits across epochs.
 */
const editCountMeasured: Measured<number, Epoch> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (ep) => ep.edits.length,
};

const editCountView = monoidalView({
  name: "edit-count",
  description: "Total edit count",
  measured: editCountMeasured,
});

// -- evaluateMonoidal tests --

describe("evaluateMonoidal", () => {
  it("empty tree → monoid identity", () => {
    const tree = fromEpochs([]);
    const cache = createCache<number>();

    const result = evaluateMonoidal(editCountView, tree, cache);

    expect(result).toBe(0);
  });

  it("single epoch", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2), fakeEdit(3)], closedBoundary()),
    ]);
    const cache = createCache<number>();

    const result = evaluateMonoidal(editCountView, tree, cache);

    expect(result).toBe(3);
  });

  it("multiple epochs", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4), fakeEdit(5), fakeEdit(6)], closedBoundary()),
      epoch([], openBoundary()),
    ]);
    const cache = createCache<number>();

    const result = evaluateMonoidal(editCountView, tree, cache);

    expect(result).toBe(6);
  });

  it("cache hit avoids recomputation", () => {
    const measureSpy = vi.fn((ep: Epoch) => ep.edits.length);
    const spiedMeasured: Measured<number, Epoch> = {
      monoid: { empty: 0, append: (a, b) => a + b },
      measure: measureSpy,
    };
    const spiedView = monoidalView({
      name: "spied",
      description: "Spied edit count",
      measured: spiedMeasured,
    });

    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4), fakeEdit(5)], closedBoundary()),
    ]);

    const cache = createCache<number>();

    // First evaluation: measure is called for each epoch
    const result1 = evaluateMonoidal(spiedView, tree, cache);
    expect(result1).toBe(5);
    const callsAfterFirst = measureSpy.mock.calls.length;
    expect(callsAfterFirst).toBe(3);

    // Second evaluation with same tree + cache: no
    // additional measure calls
    measureSpy.mockClear();
    const result2 = evaluateMonoidal(spiedView, tree, cache);
    expect(result2).toBe(5);
    expect(measureSpy).not.toHaveBeenCalled();
  });
});

// -- ViewCache tests --

describe("createCache + seedCache", () => {
  it("createCache returns empty cache", () => {
    const cache = createCache<number>();
    // Cache is a WeakMap — no size property, but
    // using it shouldn't throw
    expect(cache).toBeDefined();
  });

  it("seedCache pre-populates cache for a node", () => {
    const measureSpy = vi.fn((ep: Epoch) => ep.edits.length);
    const spiedMeasured: Measured<number, Epoch> = {
      monoid: { empty: 0, append: (a, b) => a + b },
      measure: measureSpy,
    };
    const spiedView = monoidalView({
      name: "spied",
      description: "Spied edit count",
      measured: spiedMeasured,
    });

    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4), fakeEdit(5)], closedBoundary()),
    ]);

    const cache = createCache<number>();
    seedCache(cache, tree, 5);

    // Evaluate should hit the seeded cache for the
    // root, returning the seeded value without calling
    // measure
    const result = evaluateMonoidal(spiedView, tree, cache);
    expect(result).toBe(5);
    expect(measureSpy).not.toHaveBeenCalled();
  });
});

// -- Property tests --

describe("evaluateMonoidal properties", () => {
  const arbEpoch = fc
    .record({
      editCount: fc.integer({ min: 0, max: 10 }),
      author: fc.constantFrom("aa", "bb", "cc"),
      timestamp: fc.integer({ min: 0, max: 1_000_000 }),
    })
    .map(({ editCount, author, timestamp }) =>
      epoch(
        Array.from({ length: editCount }, (_, i) =>
          fakeEdit(i + 1, author, "content", timestamp + i),
        ),
        closedBoundary(),
      ),
    );

  it("evaluateMonoidal = naive foldl over toArray", () => {
    fc.assert(
      fc.property(
        fc.array(arbEpoch, { minLength: 0, maxLength: 20 }),
        (epochs) => {
          const tree = fromEpochs(epochs);
          const cache = createCache<number>();

          const evaluated = evaluateMonoidal(editCountView, tree, cache);

          // Naive: fold over array with the monoid
          const naive = foldl(
            tree,
            (acc: number, ep: Epoch) =>
              editCountMeasured.monoid.append(
                acc,
                editCountMeasured.measure(ep),
              ),
            editCountMeasured.monoid.empty,
          );

          expect(evaluated).toBe(naive);
        },
      ),
      { numRuns: 200 },
    );
  });
});
