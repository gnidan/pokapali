import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { measureTree, toArray } from "@pokapali/finger-tree";
import { epochMeasured, summaryMonoid } from "./summary.js";
import { fromEpochs } from "./history.js";
import { mergeEpochs } from "./merge.js";
import {
  edit,
  epoch,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
} from "./types.js";
import type { Edit, Epoch } from "./types.js";
import type { Codec } from "@pokapali/codec";
import { splitEpochAtSnapshot } from "./split.js";

// -- Helpers --

function fakeCid(n: number): CID {
  const bytes = new Uint8Array(32);
  bytes[0] = n;
  const digest = Digest.create(0x12, bytes);
  return CID.createV1(0x71, digest);
}

function fakeEdit(
  id: number,
  author = "aabb",
  channel = "content",
  timestamp = Date.now(),
): Edit {
  return edit({
    payload: new Uint8Array([id]),
    timestamp,
    author,
    channel,
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

/**
 * A fake Codec where `contains` returns true if
 * snapshot includes the edit's payload byte.
 *
 * Snapshot is a Uint8Array treated as a set of byte
 * values. An edit's payload[0] is its identity.
 */
function fakeCodec(containedIds: Set<number>): Codec {
  return {
    merge: (a, b) => new Uint8Array([...a, ...b]),
    diff: (state, _base) => state,
    apply: (base, update) => new Uint8Array([...base, ...update]),
    empty: () => new Uint8Array([]),
    contains: (_snapshot, editPayload) => containedIds.has(editPayload[0]!),
    createSurface() {
      throw new Error("not implemented");
    },
    clockSum() {
      return 0;
    },
  };
}

// -- splitEpochAtSnapshot unit tests --

describe("splitEpochAtSnapshot", () => {
  it("splits 6-edit epoch at snapshot containing 3", () => {
    const edits = [
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(2, "bb", "content", 200),
      fakeEdit(3, "cc", "content", 300),
      fakeEdit(4, "dd", "content", 400),
      fakeEdit(5, "ee", "content", 500),
      fakeEdit(6, "ff", "content", 600),
    ];
    const ep = epoch(edits, closedBoundary());
    const tree = fromEpochs([ep]);
    const cid = fakeCid(1);
    const codec = fakeCodec(new Set([1, 2, 3]));
    const snapshot = new Uint8Array([1, 2, 3]);

    const result = splitEpochAtSnapshot(tree, 1, snapshot, cid, codec);
    const arr = toArray(result);

    expect(arr).toHaveLength(2);
    // Before: edits contained by snapshot
    expect(arr[0]!.edits).toHaveLength(3);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    if (arr[0]!.boundary.tag === "snapshotted") {
      expect(arr[0]!.boundary.cid).toBe(cid);
    }
    // After: edits NOT contained by snapshot
    expect(arr[1]!.edits).toHaveLength(3);
    expect(arr[1]!.boundary.tag).toBe("closed");
  });

  it("snapshot contains all -> before gets all, after empty", () => {
    const edits = [
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(2, "bb", "content", 200),
    ];
    const ep = epoch(edits, closedBoundary());
    const tree = fromEpochs([ep]);
    const cid = fakeCid(1);
    const codec = fakeCodec(new Set([1, 2]));
    const snapshot = new Uint8Array([1, 2]);

    const result = splitEpochAtSnapshot(tree, 1, snapshot, cid, codec);
    const arr = toArray(result);

    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(2);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    expect(arr[1]!.edits).toHaveLength(0);
    expect(arr[1]!.boundary.tag).toBe("closed");
  });

  it("snapshot contains none -> before empty, after gets all", () => {
    const edits = [
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(2, "bb", "content", 200),
    ];
    const ep = epoch(edits, closedBoundary());
    const tree = fromEpochs([ep]);
    const cid = fakeCid(1);
    const codec = fakeCodec(new Set());
    const snapshot = new Uint8Array([]);

    const result = splitEpochAtSnapshot(tree, 1, snapshot, cid, codec);
    const arr = toArray(result);

    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(0);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    expect(arr[1]!.edits).toHaveLength(2);
    expect(arr[1]!.boundary.tag).toBe("closed");
  });

  it("preserves surrounding epochs", () => {
    const ep1 = epoch(
      [fakeEdit(10, "aa", "content", 50)],
      snapshottedBoundary(fakeCid(10)),
    );
    const ep2 = epoch(
      [
        fakeEdit(1, "bb", "content", 100),
        fakeEdit(2, "cc", "content", 200),
        fakeEdit(3, "dd", "content", 300),
        fakeEdit(4, "ee", "content", 400),
      ],
      closedBoundary(),
    );
    const ep3 = epoch([fakeEdit(20, "ff", "content", 500)], openBoundary());

    const tree = fromEpochs([ep1, ep2, ep3]);
    const cid = fakeCid(2);
    const codec = fakeCodec(new Set([1, 2]));
    const snapshot = new Uint8Array([1, 2]);

    const result = splitEpochAtSnapshot(tree, 2, snapshot, cid, codec);
    const arr = toArray(result);

    expect(arr).toHaveLength(4);
    // ep1 unchanged
    expect(arr[0]!.edits).toHaveLength(1);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    // split before
    expect(arr[1]!.edits).toHaveLength(2);
    expect(arr[1]!.boundary.tag).toBe("snapshotted");
    // split after
    expect(arr[2]!.edits).toHaveLength(2);
    expect(arr[2]!.boundary.tag).toBe("closed");
    // ep3 unchanged
    expect(arr[3]!.edits).toHaveLength(1);
    expect(arr[3]!.boundary.tag).toBe("open");
  });

  it("throws if target epoch has open boundary", () => {
    const ep = epoch([fakeEdit(1, "aa", "content", 100)], openBoundary());
    const tree = fromEpochs([ep]);
    const codec = fakeCodec(new Set([1]));

    expect(() =>
      splitEpochAtSnapshot(tree, 1, new Uint8Array([1]), fakeCid(1), codec),
    ).toThrow();
  });

  it("throws for invalid position", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1, "aa", "content", 100)], closedBoundary()),
    ]);
    const codec = fakeCodec(new Set());

    expect(() =>
      splitEpochAtSnapshot(tree, 0, new Uint8Array([]), fakeCid(1), codec),
    ).toThrow();

    expect(() =>
      splitEpochAtSnapshot(tree, 5, new Uint8Array([]), fakeCid(1), codec),
    ).toThrow();
  });
});

// -- Property tests --

const arbAuthor = fc.constantFrom("aa", "bb", "cc", "dd", "ee", "ff");

function arbEditWithId(id: number) {
  return fc
    .record({
      timestamp: fc.integer({
        min: 0,
        max: 1_000_000,
      }),
      author: arbAuthor,
      channel: fc.constantFrom("content", "comments"),
    })
    .map(({ timestamp, author, channel }) =>
      fakeEdit(id, author, channel, timestamp),
    );
}

// Generate an epoch with edits that have unique IDs
const arbEpochWithIds = fc
  .integer({ min: 1, max: 20 })
  .chain((count) => {
    const editArbs = Array.from({ length: count }, (_, i) =>
      arbEditWithId(i + 1),
    );
    return fc.tuple(...editArbs);
  })
  .map((edits) => ({
    ep: epoch(edits, closedBoundary()),
    ids: edits.map((e) => e.payload[0]!),
  }));

describe("splitEpochAtSnapshot properties", () => {
  it("split then merge = original edits", () => {
    fc.assert(
      fc.property(arbEpochWithIds, fc.nat(), ({ ep, ids }, splitRaw) => {
        // Pick a random subset of IDs for the
        // snapshot
        const splitPoint = splitRaw % (ids.length + 1);
        const containedIds = new Set(ids.slice(0, splitPoint));
        const codec = fakeCodec(containedIds);
        const snapshot = new Uint8Array([...containedIds]);
        const cid = fakeCid(1);

        const tree = fromEpochs([ep]);
        const splitTree = splitEpochAtSnapshot(tree, 1, snapshot, cid, codec);
        const arr = toArray(splitTree);

        expect(arr).toHaveLength(2);

        // Merge back
        const merged = mergeEpochs(arr[0]!, arr[1]!);

        // Same edit count
        expect(merged.edits.length).toBe(ep.edits.length);

        // Same edit payloads (as sets)
        const originalPayloads = new Set(ep.edits.map((e) => e.payload[0]));
        const mergedPayloads = new Set(merged.edits.map((e) => e.payload[0]));
        expect(mergedPayloads).toEqual(originalPayloads);
      }),
      { numRuns: 200 },
    );
  });

  it("Summary consistent after split", () => {
    fc.assert(
      fc.property(arbEpochWithIds, fc.nat(), ({ ep, ids }, splitRaw) => {
        const splitPoint = splitRaw % (ids.length + 1);
        const containedIds = new Set(ids.slice(0, splitPoint));
        const codec = fakeCodec(containedIds);
        const snapshot = new Uint8Array([...containedIds]);
        const cid = fakeCid(1);

        const tree = fromEpochs([ep]);
        const before = measureTree(epochMeasured, tree);
        const splitTree = splitEpochAtSnapshot(tree, 1, snapshot, cid, codec);
        const after = measureTree(epochMeasured, splitTree);

        // editCount preserved
        expect(after.editCount).toBe(before.editCount);
        // epochCount increases by 1
        expect(after.epochCount).toBe(before.epochCount + 1);
        // authors preserved
        expect(setsEqual(after.authors, before.authors)).toBe(true);
        // timeRange preserved
        expect(after.timeRange[0]).toBe(before.timeRange[0]);
        expect(after.timeRange[1]).toBe(before.timeRange[1]);
      }),
      { numRuns: 200 },
    );
  });
});

// -- Integration: progressive refinement --

describe("progressive refinement", () => {
  it("split at S1, split remainder at S2", () => {
    // 6 edits: ids 1-6
    const edits = [
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(2, "bb", "content", 200),
      fakeEdit(3, "cc", "content", 300),
      fakeEdit(4, "dd", "content", 400),
      fakeEdit(5, "ee", "content", 500),
      fakeEdit(6, "ff", "content", 600),
    ];

    // Start: one big epoch
    let tree = fromEpochs([epoch(edits, closedBoundary())]);

    // S1 covers edits 1,2,3
    const codec1 = fakeCodec(new Set([1, 2, 3]));
    const cid1 = fakeCid(1);
    tree = splitEpochAtSnapshot(
      tree,
      1,
      new Uint8Array([1, 2, 3]),
      cid1,
      codec1,
    );

    let arr = toArray(tree);
    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(3);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    expect(arr[1]!.edits).toHaveLength(3);
    expect(arr[1]!.boundary.tag).toBe("closed");

    // S2 covers edits 1,2,3,4,5 (split the second
    // epoch — position 2)
    const codec2 = fakeCodec(new Set([4, 5]));
    const cid2 = fakeCid(2);
    tree = splitEpochAtSnapshot(tree, 2, new Uint8Array([4, 5]), cid2, codec2);

    arr = toArray(tree);
    expect(arr).toHaveLength(3);
    // First epoch: edits 1,2,3 with S1
    expect(arr[0]!.edits).toHaveLength(3);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    // Second epoch: edits 4,5 with S2
    expect(arr[1]!.edits).toHaveLength(2);
    expect(arr[1]!.boundary.tag).toBe("snapshotted");
    // Third epoch: edit 6, closed
    expect(arr[2]!.edits).toHaveLength(1);
    expect(arr[2]!.boundary.tag).toBe("closed");

    // Verify total index
    const idx = measureTree(epochMeasured, tree);
    expect(idx.epochCount).toBe(3);
    expect(idx.editCount).toBe(6);
    expect(idx.snapshotCount).toBe(2);
    expect(idx.timeRange).toEqual([100, 600]);
    expect(idx.authors.size).toBe(6);
  });
});
