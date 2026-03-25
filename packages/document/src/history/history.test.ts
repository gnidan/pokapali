import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { measureTree, snoc, split, toArray } from "@pokapali/finger-tree";
import { epochMeasured } from "./summary.js";
import { fromEpochs, emptyTree, History } from "./history.js";
import {
  edit,
  epoch,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
} from "./types.js";

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

// -- Tests --

describe("emptyTree", () => {
  it("returns an empty finger tree", () => {
    const tree = emptyTree();
    expect(tree.tag).toBe("empty");
  });

  it("has identity index", () => {
    const tree = emptyTree();
    const idx = measureTree(epochMeasured, tree);
    expect(idx.epochCount).toBe(0);
    expect(idx.editCount).toBe(0);
    expect(idx.authors.size).toBe(0);
    expect(idx.snapshotCount).toBe(0);
  });
});

describe("History.empty", () => {
  it("returns an empty finger tree", () => {
    const tree = History.empty();
    expect(tree.tag).toBe("empty");
  });
});

describe("fromEpochs", () => {
  it("empty array produces empty tree", () => {
    const tree = fromEpochs([]);
    expect(tree.tag).toBe("empty");
  });

  it("single epoch", () => {
    const ep = epoch([fakeEdit("aa", "content", 100)], openBoundary());
    const tree = fromEpochs([ep]);
    expect(tree.tag).toBe("single");
    expect(toArray(tree)).toHaveLength(1);
  });

  it("preserves epoch order", () => {
    const ep1 = epoch(
      [fakeEdit("aa", "content", 100)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep2 = epoch([fakeEdit("bb", "content", 200)], closedBoundary());
    const ep3 = epoch([fakeEdit("cc", "content", 300)], openBoundary());

    const tree = fromEpochs([ep1, ep2, ep3]);
    const arr = toArray(tree);

    expect(arr).toHaveLength(3);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    expect(arr[1]!.boundary.tag).toBe("closed");
    expect(arr[2]!.boundary.tag).toBe("open");
  });

  it("aggregates index across epochs", () => {
    const ep1 = epoch(
      [fakeEdit("aa", "content", 100), fakeEdit("bb", "content", 200)],
      snapshottedBoundary(fakeCid(1)),
    );
    const ep2 = epoch([fakeEdit("cc", "content", 300)], closedBoundary());

    const tree = fromEpochs([ep1, ep2]);
    const idx = measureTree(epochMeasured, tree);

    expect(idx.epochCount).toBe(2);
    expect(idx.editCount).toBe(3);
    expect(idx.timeRange).toEqual([100, 300]);
    expect(idx.authors.size).toBe(3);
    expect(idx.snapshotCount).toBe(1);
  });
});

describe("History.fromEpochs", () => {
  it("delegates to fromEpochs", () => {
    const ep = epoch([fakeEdit("aa", "content", 100)], openBoundary());
    const tree = History.fromEpochs([ep]);
    expect(toArray(tree)).toHaveLength(1);
  });
});

describe("History.fromSnapshots", () => {
  it("builds tree from snapshots", () => {
    const tree = History.fromSnapshots([
      {
        cid: fakeCid(1),
        state: new Uint8Array([1]),
      },
      {
        cid: fakeCid(2),
        state: new Uint8Array([2]),
      },
    ]);
    const arr = toArray(tree);
    expect(arr).toHaveLength(2);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    expect(arr[1]!.boundary.tag).toBe("snapshotted");
  });
});

describe("History with snoc", () => {
  it("builds tree incrementally", () => {
    let tree = emptyTree();
    tree = snoc(
      epochMeasured,
      tree,
      epoch([fakeEdit("aa", "content", 100)], snapshottedBoundary(fakeCid(1))),
    );
    tree = snoc(
      epochMeasured,
      tree,
      epoch([fakeEdit("bb", "content", 200)], openBoundary()),
    );

    const idx = measureTree(epochMeasured, tree);
    expect(idx.epochCount).toBe(2);
    expect(idx.editCount).toBe(2);
    expect(idx.snapshotCount).toBe(1);
  });
});

describe("History navigation queries", () => {
  const ep1 = epoch(
    [fakeEdit("aa", "content", 100)],
    snapshottedBoundary(fakeCid(1)),
  );
  const ep2 = epoch(
    [fakeEdit("bb", "content", 200), fakeEdit("bb", "content", 300)],
    closedBoundary(),
  );
  const ep3 = epoch(
    [fakeEdit("cc", "content", 400)],
    snapshottedBoundary(fakeCid(2)),
  );
  const ep4 = epoch([fakeEdit("dd", "content", 500)], openBoundary());

  const tree = fromEpochs([ep1, ep2, ep3, ep4]);

  it("find Nth epoch", () => {
    const result = split(epochMeasured, (v) => v.epochCount >= 2, tree);
    expect(result).toBeDefined();
    expect(result!.value).toBe(ep2);
  });

  it("find epoch containing edit #N", () => {
    // ep1 has 1 edit, ep2 has 2 edits
    // cumulative: ep1=1, ep2=3, ep3=4, ep4=5
    // editCount >= 3 first true after ep2
    const result = split(epochMeasured, (v) => v.editCount >= 3, tree);
    expect(result).toBeDefined();
    expect(result!.value).toBe(ep2);
  });

  it("find epoch at time T", () => {
    // timeRange[1] >= 300: ep1 max=100 (no),
    // ep1+ep2 max=300 (yes at ep2)
    const result = split(epochMeasured, (v) => v.timeRange[1] >= 300, tree);
    expect(result).toBeDefined();
    expect(result!.value).toBe(ep2);
  });

  it("find nearest snapshot", () => {
    // snapshotCount >= 1: ep1 is snapshotted
    const result = split(epochMeasured, (v) => v.snapshotCount >= 1, tree);
    expect(result).toBeDefined();
    expect(result!.value).toBe(ep1);
  });

  it("find second snapshot", () => {
    const result = split(epochMeasured, (v) => v.snapshotCount >= 2, tree);
    expect(result).toBeDefined();
    expect(result!.value).toBe(ep3);
  });

  it("find epochs by author", () => {
    const result = split(epochMeasured, (v) => v.authors.has("cc"), tree);
    expect(result).toBeDefined();
    expect(result!.value).toBe(ep3);
  });

  it("returns undefined when predicate never true", () => {
    const result = split(epochMeasured, (v) => v.epochCount >= 100, tree);
    expect(result).toBeUndefined();
  });
});

describe("History.mergeAdjacent", () => {
  it("merges two adjacent epochs", () => {
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
    const result = History.mergeAdjacent(tree, 2);
    const arr = toArray(result);

    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(1);
    expect(arr[1]!.edits).toHaveLength(2);
  });

  it("throws for position < 1", () => {
    const tree = fromEpochs([
      epoch([fakeEdit("aa", "content", 100)], closedBoundary()),
    ]);
    expect(() => History.mergeAdjacent(tree, 0)).toThrow();
  });

  it("throws for position beyond tree size", () => {
    const tree = fromEpochs([
      epoch([fakeEdit("aa", "content", 100)], closedBoundary()),
      epoch([fakeEdit("bb", "content", 200)], closedBoundary()),
    ]);
    expect(() => History.mergeAdjacent(tree, 3)).toThrow();
  });
});

describe("History.backfill", () => {
  it("distributes edits across snapshot epochs", () => {
    const snapshots = [
      {
        cid: fakeCid(1),
        state: new Uint8Array([1, 2]),
      },
      {
        cid: fakeCid(2),
        state: new Uint8Array([1, 2, 3, 4]),
      },
    ];

    const edits = [
      edit({
        payload: new Uint8Array([1]),
        timestamp: 100,
        author: "aa",
        channel: "content",
        origin: "local" as const,
        signature: new Uint8Array([1]),
      }),
      edit({
        payload: new Uint8Array([3]),
        timestamp: 300,
        author: "cc",
        channel: "content",
        origin: "local" as const,
        signature: new Uint8Array([3]),
      }),
    ];

    const codec = {
      merge: (a: Uint8Array, b: Uint8Array) => new Uint8Array([...a, ...b]),
      diff: (state: Uint8Array) => state,
      apply: (base: Uint8Array, update: Uint8Array) =>
        new Uint8Array([...base, ...update]),
      empty: () => new Uint8Array([]),
      contains: (snapshot: Uint8Array, editPayload: Uint8Array) => {
        const id = editPayload[0]!;
        for (const b of snapshot) {
          if (b === id) return true;
        }
        return false;
      },
    };

    const result = History.backfill(snapshots, edits, codec);
    const arr = toArray(result);

    // Edit 1 -> epoch 0 (in S1)
    // Edit 3 -> epoch 1 (in S2 but not S1)
    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(1);
    expect(arr[1]!.edits).toHaveLength(1);
  });
});
