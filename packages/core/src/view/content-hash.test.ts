import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { snoc, foldl } from "@pokapali/finger-tree";
import { epochMeasured } from "../epoch/index-monoid.js";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary, openBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import { evaluateMonoidal, createCache } from "./evaluate.js";
import { contentHashView } from "./content-hash.js";

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

const view = contentHashView();

// -- contentHashView tests --

describe("contentHashView", () => {
  it("has correct metadata", () => {
    expect(view.name).toBe("content-hash");
    expect(view.description).toContain("XOR");
  });

  it("empty tree → zero hash", () => {
    const tree = fromEpochs([]);
    const cache = createCache<Uint8Array>();

    const result = evaluateMonoidal(view, tree, cache);

    // 32 zero bytes (SHA-256 identity for XOR)
    expect(result).toEqual(new Uint8Array(32));
    expect(result.length).toBe(32);
  });

  it("single edit → non-zero hash", () => {
    const tree = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);
    const cache = createCache<Uint8Array>();

    const result = evaluateMonoidal(view, tree, cache);

    expect(result.length).toBe(32);
    // Should not be all zeros
    expect(result.some((b) => b !== 0)).toBe(true);
  });

  it("two identical edits cancel out (XOR)", () => {
    const e = fakeEdit(1, "aa", "content", 100);
    const tree = fromEpochs([epoch([e, e], closedBoundary())]);
    const cache = createCache<Uint8Array>();

    const result = evaluateMonoidal(view, tree, cache);

    // XOR of same hash = zero
    expect(result).toEqual(new Uint8Array(32));
  });

  it("order within epoch doesn't matter", () => {
    const e1 = fakeEdit(1, "aa", "content", 100);
    const e2 = fakeEdit(2, "bb", "content", 200);

    const tree1 = fromEpochs([epoch([e1, e2], closedBoundary())]);
    const tree2 = fromEpochs([epoch([e2, e1], closedBoundary())]);

    const cache1 = createCache<Uint8Array>();
    const cache2 = createCache<Uint8Array>();

    const result1 = evaluateMonoidal(view, tree1, cache1);
    const result2 = evaluateMonoidal(view, tree2, cache2);

    expect(result1).toEqual(result2);
  });

  it("same edits, different epoch boundaries → same hash", () => {
    const e1 = fakeEdit(1, "aa", "content", 100);
    const e2 = fakeEdit(2, "bb", "content", 200);
    const e3 = fakeEdit(3, "cc", "content", 300);

    // All in one epoch
    const tree1 = fromEpochs([epoch([e1, e2, e3], closedBoundary())]);
    // Split across two epochs
    const tree2 = fromEpochs([
      epoch([e1], closedBoundary()),
      epoch([e2, e3], closedBoundary()),
    ]);
    // Each in its own epoch
    const tree3 = fromEpochs([
      epoch([e1], closedBoundary()),
      epoch([e2], closedBoundary()),
      epoch([e3], closedBoundary()),
    ]);

    const c1 = createCache<Uint8Array>();
    const c2 = createCache<Uint8Array>();
    const c3 = createCache<Uint8Array>();

    const r1 = evaluateMonoidal(view, tree1, c1);
    const r2 = evaluateMonoidal(view, tree2, c2);
    const r3 = evaluateMonoidal(view, tree3, c3);

    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it("different edits → different hashes", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);
    const tree2 = fromEpochs([epoch([fakeEdit(2)], closedBoundary())]);

    const c1 = createCache<Uint8Array>();
    const c2 = createCache<Uint8Array>();

    const r1 = evaluateMonoidal(view, tree1, c1);
    const r2 = evaluateMonoidal(view, tree2, c2);

    expect(r1).not.toEqual(r2);
  });
});

// -- Property tests --

describe("contentHashView properties", () => {
  const arbEdit = fc
    .record({
      id: fc.integer({ min: 1, max: 255 }),
      author: fc.constantFrom("aa", "bb", "cc"),
      timestamp: fc.integer({ min: 0, max: 1_000_000 }),
    })
    .map(({ id, author, timestamp }) =>
      fakeEdit(id, author, "content", timestamp),
    );

  it("same edits, different boundaries → same hash", () => {
    fc.assert(
      fc.property(
        fc.array(arbEdit, { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 5 }),
        (edits, splitCount) => {
          // Build one big epoch
          const tree1 = fromEpochs([epoch(edits, closedBoundary())]);

          // Split edits across multiple epochs
          const epochs = [];
          const step = Math.max(1, Math.ceil(edits.length / splitCount));
          for (let i = 0; i < edits.length; i += step) {
            epochs.push(epoch(edits.slice(i, i + step), closedBoundary()));
          }
          const tree2 = fromEpochs(epochs);

          const c1 = createCache<Uint8Array>();
          const c2 = createCache<Uint8Array>();

          const r1 = evaluateMonoidal(view, tree1, c1);
          const r2 = evaluateMonoidal(view, tree2, c2);

          expect(r1).toEqual(r2);
        },
      ),
      { numRuns: 200 },
    );
  });
});
