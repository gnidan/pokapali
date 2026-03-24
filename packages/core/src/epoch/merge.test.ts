import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { measureTree, toArray } from "@pokapali/finger-tree";
import { epochMeasured, epochIndexMonoid } from "./index-monoid.js";
import type { EpochIndex } from "./index-monoid.js";
import { fromEpochs } from "./tree.js";
import {
  edit,
  epoch,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
} from "./types.js";
import type { Epoch } from "./types.js";
import { mergeEpochs, mergeAdjacentInTree } from "./merge.js";

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

// -- mergeEpochs tests --

describe("mergeEpochs", () => {
  it("unions edits from both epochs", () => {
    const e1 = fakeEdit("aa", "content", 100);
    const e2 = fakeEdit("bb", "comments", 200);
    const e3 = fakeEdit("cc", "content", 300);

    const a = epoch([e1, e2], closedBoundary());
    const b = epoch([e3], closedBoundary());

    const merged = mergeEpochs(a, b);
    expect(merged.edits).toHaveLength(3);
    expect(merged.edits).toContain(e1);
    expect(merged.edits).toContain(e2);
    expect(merged.edits).toContain(e3);
  });

  it("takes b's boundary", () => {
    const a = epoch(
      [fakeEdit("aa", "content", 100)],
      snapshottedBoundary(fakeCid(1)),
    );
    const b = epoch([fakeEdit("bb", "content", 200)], closedBoundary());

    const merged = mergeEpochs(a, b);
    expect(merged.boundary.tag).toBe("closed");
  });

  it("snapshotted + closed = closed (desampling)", () => {
    const a = epoch(
      [fakeEdit("aa", "content", 100)],
      snapshottedBoundary(fakeCid(1)),
    );
    const b = epoch([fakeEdit("bb", "content", 200)], closedBoundary());

    const merged = mergeEpochs(a, b);
    expect(merged.boundary.tag).toBe("closed");
  });

  it("closed + snapshotted = snapshotted", () => {
    const a = epoch([fakeEdit("aa", "content", 100)], closedBoundary());
    const b = epoch(
      [fakeEdit("bb", "content", 200)],
      snapshottedBoundary(fakeCid(2)),
    );

    const merged = mergeEpochs(a, b);
    expect(merged.boundary.tag).toBe("snapshotted");
    if (merged.boundary.tag === "snapshotted") {
      expect(merged.boundary.cid).toBe(
        b.boundary.tag === "snapshotted" ? b.boundary.cid : undefined,
      );
    }
  });

  it("merge into empty-edits epoch (hydration)", () => {
    const a = epoch([], snapshottedBoundary(fakeCid(1)));
    const b = epoch([fakeEdit("bb", "content", 200)], closedBoundary());

    const merged = mergeEpochs(a, b);
    expect(merged.edits).toHaveLength(1);
    expect(merged.boundary.tag).toBe("closed");
  });

  it("merge two empty-edits epochs", () => {
    const a = epoch([], closedBoundary());
    const b = epoch([], snapshottedBoundary(fakeCid(1)));

    const merged = mergeEpochs(a, b);
    expect(merged.edits).toHaveLength(0);
    expect(merged.boundary.tag).toBe("snapshotted");
  });

  it("throws if b has open boundary", () => {
    const a = epoch([fakeEdit("aa", "content", 100)], closedBoundary());
    const b = epoch([fakeEdit("bb", "content", 200)], openBoundary());

    expect(() => mergeEpochs(a, b)).toThrow();
  });

  it("throws if a has open boundary", () => {
    const a = epoch([fakeEdit("aa", "content", 100)], openBoundary());
    const b = epoch([fakeEdit("bb", "content", 200)], closedBoundary());

    expect(() => mergeEpochs(a, b)).toThrow();
  });
});

// -- mergeAdjacentInTree tests --

describe("mergeAdjacentInTree", () => {
  it("merges two adjacent epochs at position", () => {
    const ep1 = epoch(
      [fakeEdit("aa", "content", 100)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep2 = epoch(
      [fakeEdit("bb", "content", 200)],
      snapshottedBoundary(fakeCid(2)),
    );
    const ep3 = epoch([fakeEdit("cc", "content", 300)], closedBoundary());

    const tree = fromEpochs([ep1, ep2, ep3]);
    const result = mergeAdjacentInTree(tree, 2);
    const arr = toArray(result);

    expect(arr).toHaveLength(2);
    // First epoch unchanged
    expect(arr[0]!.edits).toHaveLength(1);
    // Merged epoch has union of ep2+ep3 edits
    expect(arr[1]!.edits).toHaveLength(2);
    expect(arr[1]!.boundary.tag).toBe("closed");
  });

  it("merges first two epochs at position 1", () => {
    const ep1 = epoch([fakeEdit("aa", "content", 100)], closedBoundary());
    const ep2 = epoch(
      [fakeEdit("bb", "content", 200)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep3 = epoch([fakeEdit("cc", "content", 300)], closedBoundary());

    const tree = fromEpochs([ep1, ep2, ep3]);
    const result = mergeAdjacentInTree(tree, 1);
    const arr = toArray(result);

    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(2);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
  });

  it("preserves tree index after merge", () => {
    const ep1 = epoch(
      [fakeEdit("aa", "content", 100)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep2 = epoch(
      [fakeEdit("bb", "content", 200), fakeEdit("cc", "content", 300)],
      closedBoundary(),
    );
    const ep3 = epoch([fakeEdit("dd", "content", 400)], closedBoundary());

    const tree = fromEpochs([ep1, ep2, ep3]);
    const result = mergeAdjacentInTree(tree, 2);
    const idx = measureTree(epochMeasured, result);

    expect(idx.epochCount).toBe(2);
    expect(idx.editCount).toBe(4);
    expect(idx.timeRange).toEqual([100, 400]);
    expect(idx.authors.size).toBe(4);
  });

  it("throws for position < 1", () => {
    const tree = fromEpochs([
      epoch([fakeEdit("aa", "content", 100)], closedBoundary()),
    ]);
    expect(() => mergeAdjacentInTree(tree, 0)).toThrow();
  });

  it("throws for position beyond tree size", () => {
    const tree = fromEpochs([
      epoch([fakeEdit("aa", "content", 100)], closedBoundary()),
      epoch([fakeEdit("bb", "content", 200)], closedBoundary()),
    ]);
    expect(() => mergeAdjacentInTree(tree, 3)).toThrow();
  });
});

// -- Property tests --

const arbAuthor = fc.constantFrom("aa", "bb", "cc", "dd", "ee", "ff");

const arbEditForProp = fc.record({
  payload: fc.constant(new Uint8Array([1])),
  timestamp: fc.integer({ min: 0, max: 1_000_000 }),
  author: arbAuthor,
  channel: fc.constantFrom("content", "comments"),
  origin: fc.constant("local" as const),
  signature: fc.constant(new Uint8Array([])),
});

const arbClosedEpoch = fc.array(arbEditForProp, { maxLength: 5 }).map((edits) =>
  epoch(
    edits.map((e) => edit(e)),
    closedBoundary(),
  ),
);

describe("mergeEpochs properties", () => {
  it(
    "index of merged = append(index(a), index(b))" + " with epochCount - 1",
    () => {
      fc.assert(
        fc.property(arbClosedEpoch, arbClosedEpoch, (a, b) => {
          const merged = mergeEpochs(a, b);

          const idxA = epochMeasured.measure(a);
          const idxB = epochMeasured.measure(b);
          const combined = epochIndexMonoid.append(idxA, idxB);
          const idxMerged = epochMeasured.measure(merged);

          // editCount is sum
          expect(idxMerged.editCount).toBe(combined.editCount);
          // epochCount is 1 (single merged epoch)
          expect(idxMerged.epochCount).toBe(1);
          // authors is union
          expect(setsEqual(idxMerged.authors, combined.authors)).toBe(true);
          // timeRange matches
          expect(idxMerged.timeRange[0]).toBe(combined.timeRange[0]);
          expect(idxMerged.timeRange[1]).toBe(combined.timeRange[1]);
        }),
        { numRuns: 200 },
      );
    },
  );

  it("edit count is sum of inputs", () => {
    fc.assert(
      fc.property(arbClosedEpoch, arbClosedEpoch, (a, b) => {
        const merged = mergeEpochs(a, b);
        expect(merged.edits.length).toBe(a.edits.length + b.edits.length);
      }),
      { numRuns: 200 },
    );
  });
});

describe("mergeAdjacentInTree properties", () => {
  it("tree size decreases by 1", () => {
    fc.assert(
      fc.property(
        fc.array(arbClosedEpoch, {
          minLength: 2,
          maxLength: 8,
        }),
        fc.nat(),
        (epochs, posRaw) => {
          const pos = (posRaw % (epochs.length - 1)) + 1;
          const tree = fromEpochs(epochs);
          const result = mergeAdjacentInTree(tree, pos);
          expect(toArray(result)).toHaveLength(epochs.length - 1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("total editCount preserved after merge", () => {
    fc.assert(
      fc.property(
        fc.array(arbClosedEpoch, {
          minLength: 2,
          maxLength: 8,
        }),
        fc.nat(),
        (epochs, posRaw) => {
          const pos = (posRaw % (epochs.length - 1)) + 1;
          const tree = fromEpochs(epochs);
          const result = mergeAdjacentInTree(tree, pos);

          const before = measureTree(epochMeasured, tree);
          const after = measureTree(epochMeasured, result);

          expect(after.editCount).toBe(before.editCount);
          expect(after.epochCount).toBe(before.epochCount - 1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
