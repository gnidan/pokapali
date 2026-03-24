import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import {
  fromArray,
  measureTree,
  snoc,
  empty,
  split,
  toArray,
} from "@pokapali/finger-tree";
import {
  Sum,
  MinMax,
  SetUnion,
  epochIndexMonoid,
  epochMeasured,
} from "./index-monoid.js";
import type { EpochIndex } from "./index-monoid.js";
import {
  edit,
  epoch,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
} from "./types.js";
import type { Epoch } from "./types.js";

// -- Helpers --

function fakeCid(n: number): CID {
  const bytes = new Uint8Array(32);
  bytes[0] = n;
  const digest = Digest.create(0x12, bytes);
  return CID.createV1(0x71, digest);
}

function fakeEdit(
  author = "aabb",
  channel = "content",
  timestamp = Date.now(),
) {
  return edit({
    payload: new Uint8Array([1, 2, 3]),
    timestamp,
    author,
    channel,
    origin: "local",
    signature: new Uint8Array([4, 5, 6]),
  });
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

function epochIndexEq(a: EpochIndex, b: EpochIndex): boolean {
  return (
    a.epochCount === b.epochCount &&
    a.editCount === b.editCount &&
    a.timeRange[0] === b.timeRange[0] &&
    a.timeRange[1] === b.timeRange[1] &&
    a.snapshotCount === b.snapshotCount &&
    setsEqual(a.authors, b.authors)
  );
}

// -- Monoid law tests --

describe("Sum monoid laws", () => {
  it("left identity", () => {
    fc.assert(
      fc.property(fc.integer(), (v) => {
        expect(Sum.append(Sum.empty, v)).toBe(v);
      }),
    );
  });

  it("right identity", () => {
    fc.assert(
      fc.property(fc.integer(), (v) => {
        expect(Sum.append(v, Sum.empty)).toBe(v);
      }),
    );
  });

  it("associativity", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), fc.integer(), (a, b, c) => {
        expect(Sum.append(Sum.append(a, b), c)).toBe(
          Sum.append(a, Sum.append(b, c)),
        );
      }),
    );
  });
});

describe("MinMax monoid laws", () => {
  const arbRange: fc.Arbitrary<readonly [number, number]> = fc
    .tuple(fc.integer(), fc.integer())
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const);

  it("left identity", () => {
    fc.assert(
      fc.property(arbRange, (v) => {
        const r = MinMax.append(MinMax.empty, v);
        expect(r[0]).toBe(v[0]);
        expect(r[1]).toBe(v[1]);
      }),
    );
  });

  it("right identity", () => {
    fc.assert(
      fc.property(arbRange, (v) => {
        const r = MinMax.append(v, MinMax.empty);
        expect(r[0]).toBe(v[0]);
        expect(r[1]).toBe(v[1]);
      }),
    );
  });

  it("associativity", () => {
    fc.assert(
      fc.property(arbRange, arbRange, arbRange, (a, b, c) => {
        const lhs = MinMax.append(MinMax.append(a, b), c);
        const rhs = MinMax.append(a, MinMax.append(b, c));
        expect(lhs[0]).toBe(rhs[0]);
        expect(lhs[1]).toBe(rhs[1]);
      }),
    );
  });
});

describe("SetUnion monoid laws", () => {
  const arbSet: fc.Arbitrary<ReadonlySet<string>> = fc
    .array(fc.string({ minLength: 1, maxLength: 4 }), {
      maxLength: 5,
    })
    .map((arr) => new Set(arr));

  it("left identity", () => {
    fc.assert(
      fc.property(arbSet, (v) => {
        expect(setsEqual(SetUnion.append(SetUnion.empty, v), v)).toBe(true);
      }),
    );
  });

  it("right identity", () => {
    fc.assert(
      fc.property(arbSet, (v) => {
        expect(setsEqual(SetUnion.append(v, SetUnion.empty), v)).toBe(true);
      }),
    );
  });

  it("associativity", () => {
    fc.assert(
      fc.property(arbSet, arbSet, arbSet, (a, b, c) => {
        expect(
          setsEqual(
            SetUnion.append(SetUnion.append(a, b), c),
            SetUnion.append(a, SetUnion.append(b, c)),
          ),
        ).toBe(true);
      }),
    );
  });
});

describe("epochIndexMonoid laws", () => {
  const arbIndex: fc.Arbitrary<EpochIndex> = fc.record({
    epochCount: fc.nat({ max: 100 }),
    editCount: fc.nat({ max: 1000 }),
    timeRange: fc
      .tuple(fc.integer(), fc.integer())
      .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const),
    authors: fc
      .array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 5 })
      .map((arr) => new Set(arr) as ReadonlySet<string>),
    snapshotCount: fc.nat({ max: 50 }),
  });

  it("left identity", () => {
    fc.assert(
      fc.property(arbIndex, (v) => {
        expect(
          epochIndexEq(epochIndexMonoid.append(epochIndexMonoid.empty, v), v),
        ).toBe(true);
      }),
    );
  });

  it("right identity", () => {
    fc.assert(
      fc.property(arbIndex, (v) => {
        expect(
          epochIndexEq(epochIndexMonoid.append(v, epochIndexMonoid.empty), v),
        ).toBe(true);
      }),
    );
  });

  it("associativity", () => {
    fc.assert(
      fc.property(arbIndex, arbIndex, arbIndex, (a, b, c) => {
        expect(
          epochIndexEq(
            epochIndexMonoid.append(epochIndexMonoid.append(a, b), c),
            epochIndexMonoid.append(a, epochIndexMonoid.append(b, c)),
          ),
        ).toBe(true);
      }),
    );
  });
});

// -- measureEpoch tests --

describe("epochMeasured.measure", () => {
  it("counts one epoch", () => {
    const ep = epoch([fakeEdit("aa", "content", 1000)], openBoundary());
    const idx = epochMeasured.measure(ep);
    expect(idx.epochCount).toBe(1);
  });

  it("counts edits", () => {
    const ep = epoch(
      [
        fakeEdit("aa", "content", 100),
        fakeEdit("bb", "comments", 200),
        fakeEdit("cc", "content", 300),
      ],
      closedBoundary(),
    );
    const idx = epochMeasured.measure(ep);
    expect(idx.editCount).toBe(3);
  });

  it("computes time range", () => {
    const ep = epoch(
      [
        fakeEdit("aa", "content", 100),
        fakeEdit("bb", "comments", 500),
        fakeEdit("cc", "content", 300),
      ],
      closedBoundary(),
    );
    const idx = epochMeasured.measure(ep);
    expect(idx.timeRange[0]).toBe(100);
    expect(idx.timeRange[1]).toBe(500);
  });

  it("collects unique authors", () => {
    const ep = epoch(
      [
        fakeEdit("aa", "content", 100),
        fakeEdit("bb", "content", 200),
        fakeEdit("aa", "content", 300),
      ],
      closedBoundary(),
    );
    const idx = epochMeasured.measure(ep);
    expect(idx.authors.size).toBe(2);
    expect(idx.authors.has("aa")).toBe(true);
    expect(idx.authors.has("bb")).toBe(true);
  });

  it("snapshotCount 1 for snapshotted", () => {
    const ep = epoch(
      [fakeEdit("aa", "content", 100)],
      snapshottedBoundary(fakeCid(1)),
    );
    const idx = epochMeasured.measure(ep);
    expect(idx.snapshotCount).toBe(1);
  });

  it("snapshotCount 0 for open", () => {
    const ep = epoch([fakeEdit("aa", "content", 100)], openBoundary());
    const idx = epochMeasured.measure(ep);
    expect(idx.snapshotCount).toBe(0);
  });

  it("snapshotCount 0 for closed", () => {
    const ep = epoch([fakeEdit("aa", "content", 100)], closedBoundary());
    const idx = epochMeasured.measure(ep);
    expect(idx.snapshotCount).toBe(0);
  });

  it("empty edits epoch", () => {
    const ep = epoch([], snapshottedBoundary(fakeCid(1)));
    const idx = epochMeasured.measure(ep);
    expect(idx.epochCount).toBe(1);
    expect(idx.editCount).toBe(0);
    expect(idx.timeRange[0]).toBe(Infinity);
    expect(idx.timeRange[1]).toBe(-Infinity);
    expect(idx.authors.size).toBe(0);
    expect(idx.snapshotCount).toBe(1);
  });
});

// -- Finger tree integration tests --

describe("EpochIndex in finger tree", () => {
  function buildTree(epochs: Epoch[]) {
    return fromArray(epochMeasured, epochs);
  }

  it("empty tree has monoid identity", () => {
    const tree = empty<EpochIndex, Epoch>();
    const idx = measureTree(epochMeasured, tree);
    expect(idx.epochCount).toBe(0);
    expect(idx.editCount).toBe(0);
    expect(idx.snapshotCount).toBe(0);
    expect(idx.authors.size).toBe(0);
  });

  it("single epoch tree", () => {
    const ep = epoch(
      [fakeEdit("aa", "content", 100), fakeEdit("bb", "content", 200)],
      closedBoundary(),
    );
    const tree = fromArray(epochMeasured, [ep]);
    const idx = measureTree(epochMeasured, tree);

    expect(idx.epochCount).toBe(1);
    expect(idx.editCount).toBe(2);
    expect(idx.timeRange).toEqual([100, 200]);
    expect(idx.authors.size).toBe(2);
    expect(idx.snapshotCount).toBe(0);
  });

  it("multi-epoch tree aggregates correctly", () => {
    const ep1 = epoch(
      [fakeEdit("aa", "content", 100)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep2 = epoch(
      [fakeEdit("bb", "content", 200), fakeEdit("cc", "content", 300)],
      closedBoundary(),
    );
    const ep3 = epoch([fakeEdit("aa", "content", 400)], openBoundary());

    const tree = buildTree([ep1, ep2, ep3]);
    const idx = measureTree(epochMeasured, tree);

    expect(idx.epochCount).toBe(3);
    expect(idx.editCount).toBe(4);
    expect(idx.timeRange).toEqual([100, 400]);
    expect(idx.authors.size).toBe(3);
    expect(idx.snapshotCount).toBe(1);
  });

  it("snoc appends and updates index", () => {
    let tree = empty<EpochIndex, Epoch>();
    tree = snoc(
      epochMeasured,
      tree,
      epoch([fakeEdit("aa", "content", 100)], closedBoundary()),
    );
    tree = snoc(
      epochMeasured,
      tree,
      epoch([fakeEdit("bb", "content", 200)], openBoundary()),
    );

    const idx = measureTree(epochMeasured, tree);
    expect(idx.epochCount).toBe(2);
    expect(idx.editCount).toBe(2);
  });

  it("split finds epoch by edit count", () => {
    const ep1 = epoch(
      [fakeEdit("aa", "content", 100), fakeEdit("aa", "content", 200)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep2 = epoch(
      [
        fakeEdit("bb", "content", 300),
        fakeEdit("bb", "content", 400),
        fakeEdit("bb", "content", 500),
      ],
      closedBoundary(),
    );
    const ep3 = epoch([fakeEdit("cc", "content", 600)], openBoundary());

    const tree = buildTree([ep1, ep2, ep3]);

    // Split where cumulative editCount > 2
    // ep1 has 2 edits, so accumulated after ep1 = 2,
    // not > 2. After ep2, accumulated = 5, which is > 2.
    const result = split(epochMeasured, (v) => v.editCount > 2, tree);

    expect(result).toBeDefined();
    expect(result!.value.edits).toHaveLength(3);
    expect(toArray(result!.left)).toHaveLength(1);
    expect(toArray(result!.right)).toHaveLength(1);
  });

  it("split finds first snapshot", () => {
    const ep1 = epoch([fakeEdit("aa", "content", 100)], closedBoundary());
    const ep2 = epoch(
      [fakeEdit("bb", "content", 200)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep3 = epoch([fakeEdit("cc", "content", 300)], openBoundary());

    const tree = buildTree([ep1, ep2, ep3]);

    const result = split(epochMeasured, (v) => v.snapshotCount > 0, tree);

    expect(result).toBeDefined();
    expect(result!.value.boundary.tag).toBe("snapshotted");
    expect(toArray(result!.left)).toHaveLength(1);
  });
});

// -- Property tests: measureTree matches manual fold --

const arbAuthor = fc.constantFrom("aa", "bb", "cc", "dd", "ee", "ff");

const arbEditForProp = fc.record({
  payload: fc.constant(new Uint8Array([1])),
  timestamp: fc.integer({ min: 0, max: 1_000_000 }),
  author: arbAuthor,
  channel: fc.constantFrom("content", "comments"),
  origin: fc.constant("local" as const),
  signature: fc.constant(new Uint8Array([])),
});

const arbBoundary = fc.oneof(
  fc.constant(openBoundary()),
  fc.constant(closedBoundary()),
  fc.integer({ min: 0, max: 255 }).map((n) => snapshottedBoundary(fakeCid(n))),
);

const arbEpoch = fc
  .tuple(fc.array(arbEditForProp, { maxLength: 5 }), arbBoundary)
  .map(([edits, boundary]) =>
    epoch(
      edits.map((e) => edit(e)),
      boundary,
    ),
  );

describe("measureTree matches manual fold", () => {
  it("tree index equals fold of individual measures", () => {
    fc.assert(
      fc.property(
        fc.array(arbEpoch, { minLength: 0, maxLength: 10 }),
        (epochs) => {
          const tree = fromArray(epochMeasured, epochs);
          const treeIdx = measureTree(epochMeasured, tree);

          const foldIdx = epochs.reduce(
            (acc, ep) =>
              epochIndexMonoid.append(acc, epochMeasured.measure(ep)),
            epochIndexMonoid.empty,
          );

          expect(epochIndexEq(treeIdx, foldIdx)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// -- Property tests: split correctness --

describe("split properties", () => {
  it("split on epochCount: left + value + right = original", () => {
    fc.assert(
      fc.property(
        fc.array(arbEpoch, { minLength: 1, maxLength: 10 }),
        (epochs) => {
          const tree = fromArray(epochMeasured, epochs);
          const total = measureTree(epochMeasured, tree).epochCount;

          // Pick a random target in [1, total]
          if (total === 0) return;
          const target = (Math.abs(epochs[0]!.edits.length) % total) + 1;

          const result = split(
            epochMeasured,
            (v) => v.epochCount >= target,
            tree,
          );

          expect(result).toBeDefined();

          const leftArr = toArray(result!.left);
          const rightArr = toArray(result!.right);
          const all = [...leftArr, result!.value, ...rightArr];
          expect(all).toHaveLength(epochs.length);

          // Left side has fewer than target epochs
          const leftIdx = measureTree(epochMeasured, result!.left);
          expect(leftIdx.epochCount).toBeLessThan(target);

          // Left + value reaches target
          const withValue = epochIndexMonoid.append(
            leftIdx,
            epochMeasured.measure(result!.value),
          );
          expect(withValue.epochCount).toBeGreaterThanOrEqual(target);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("split on snapshotCount finds a snapshot boundary", () => {
    fc.assert(
      fc.property(
        fc.array(arbEpoch, { minLength: 1, maxLength: 10 }),
        (epochs) => {
          const tree = fromArray(epochMeasured, epochs);
          const total = measureTree(epochMeasured, tree).snapshotCount;

          if (total === 0) return;

          const result = split(
            epochMeasured,
            (v) => v.snapshotCount >= 1,
            tree,
          );

          expect(result).toBeDefined();
          expect(result!.value.boundary.tag).toBe("snapshotted");

          // No snapshots in left
          const leftIdx = measureTree(epochMeasured, result!.left);
          expect(leftIdx.snapshotCount).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("split on timeRange finds correct epoch", () => {
    fc.assert(
      fc.property(
        fc.array(arbEpoch, { minLength: 1, maxLength: 10 }),
        (epochs) => {
          const tree = fromArray(epochMeasured, epochs);
          const idx = measureTree(epochMeasured, tree);

          // Skip if no edits (timeRange is identity)
          if (idx.editCount === 0) return;

          const target = idx.timeRange[1];
          const result = split(
            epochMeasured,
            (v) => v.timeRange[1] >= target,
            tree,
          );

          expect(result).toBeDefined();

          // The found epoch must contain an edit at
          // or after the target time
          const valIdx = epochMeasured.measure(result!.value);
          expect(valIdx.timeRange[1]).toBeGreaterThanOrEqual(target);
        },
      ),
      { numRuns: 200 },
    );
  });
});
