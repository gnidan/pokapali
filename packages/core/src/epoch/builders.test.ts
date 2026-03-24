import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { measureTree, toArray } from "@pokapali/finger-tree";
import { epochMeasured } from "./index-monoid.js";
import { edit } from "./types.js";
import type { Edit } from "./types.js";
import type { CrdtCodec } from "../codec/codec.js";
import { fromSnapshots, backfillEdits } from "./builders.js";
import type { Snapshot } from "./builders.js";

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

/**
 * Fake CrdtCodec where contains checks if snapshot
 * bytes include the edit's payload[0].
 */
function fakeCodec(): CrdtCodec {
  return {
    merge: (a, b) => new Uint8Array([...a, ...b]),
    diff: (state, _base) => state,
    apply: (base, update) => new Uint8Array([...base, ...update]),
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

// -- fromSnapshots tests --

describe("fromSnapshots", () => {
  it("builds tree from 3 snapshots", () => {
    const snapshots: Snapshot[] = [
      { cid: fakeCid(1), state: new Uint8Array([1]) },
      { cid: fakeCid(2), state: new Uint8Array([2]) },
      { cid: fakeCid(3), state: new Uint8Array([3]) },
    ];

    const tree = fromSnapshots(snapshots);
    const arr = toArray(tree);

    expect(arr).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(arr[i]!.edits).toHaveLength(0);
      expect(arr[i]!.boundary.tag).toBe("snapshotted");
      const boundary = arr[i]!.boundary;
      if (boundary.tag === "snapshotted") {
        expect(boundary.cid).toBe(snapshots[i]!.cid);
      }
    }
  });

  it("empty snapshots → empty tree", () => {
    const tree = fromSnapshots([]);
    expect(tree.tag).toBe("empty");
  });

  it("single snapshot → single epoch", () => {
    const tree = fromSnapshots([
      { cid: fakeCid(1), state: new Uint8Array([1]) },
    ]);
    const arr = toArray(tree);

    expect(arr).toHaveLength(1);
    expect(arr[0]!.edits).toHaveLength(0);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
  });

  it("has correct index", () => {
    const tree = fromSnapshots([
      { cid: fakeCid(1), state: new Uint8Array([1]) },
      { cid: fakeCid(2), state: new Uint8Array([2]) },
    ]);
    const idx = measureTree(epochMeasured, tree);

    expect(idx.epochCount).toBe(2);
    expect(idx.editCount).toBe(0);
    expect(idx.snapshotCount).toBe(2);
    expect(idx.authors.size).toBe(0);
  });
});

// -- backfillEdits tests --

describe("backfillEdits", () => {
  it("places edits in correct epochs", () => {
    // S1 covers edits 1,2; S2 covers 1,2,3,4
    const snapshots: Snapshot[] = [
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
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(2, "bb", "content", 200),
      fakeEdit(3, "cc", "content", 300),
      fakeEdit(4, "dd", "content", 400),
    ];

    const codec = fakeCodec();
    const result = backfillEdits(snapshots, edits, codec);
    const arr = toArray(result);

    // Edits 1,2 → epoch 0 (contained by S1)
    // Edits 3,4 → epoch 1 (in S2 but not S1)
    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(2);
    expect(arr[1]!.edits).toHaveLength(2);
  });

  it("edits not in any snapshot get remainder epoch", () => {
    const snapshots: Snapshot[] = [
      {
        cid: fakeCid(1),
        state: new Uint8Array([1, 2]),
      },
    ];

    const edits = [
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(3, "cc", "content", 300),
    ];

    const codec = fakeCodec();
    const result = backfillEdits(snapshots, edits, codec);
    const arr = toArray(result);

    // Edit 1 → epoch 0 (in S1), edit 3 → remainder
    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(1);
    expect(arr[0]!.edits[0]!.payload[0]).toBe(1);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    expect(arr[1]!.edits).toHaveLength(1);
    expect(arr[1]!.edits[0]!.payload[0]).toBe(3);
    expect(arr[1]!.boundary.tag).toBe("closed");
  });

  it("all edits contained by first snapshot", () => {
    const snapshots: Snapshot[] = [
      {
        cid: fakeCid(1),
        state: new Uint8Array([1, 2, 3]),
      },
      {
        cid: fakeCid(2),
        state: new Uint8Array([1, 2, 3, 4, 5]),
      },
    ];

    const edits = [
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(2, "bb", "content", 200),
    ];

    const codec = fakeCodec();
    const result = backfillEdits(snapshots, edits, codec);
    const arr = toArray(result);

    // Both edits in epoch 0 (contained by S1)
    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(2);
    expect(arr[1]!.edits).toHaveLength(0);
  });

  it("no edits → tree has empty epochs", () => {
    const snapshots: Snapshot[] = [
      {
        cid: fakeCid(1),
        state: new Uint8Array([1, 2]),
      },
    ];

    const codec = fakeCodec();
    const result = backfillEdits(snapshots, [], codec);
    const arr = toArray(result);

    expect(arr).toHaveLength(1);
    expect(arr[0]!.edits).toHaveLength(0);
  });
});

// -- Integration: full hydration cycle --

describe("full hydration cycle", () => {
  it("fromSnapshots → backfillEdits → correct tree", () => {
    // 3 snapshots from pinner:
    // S1 covers edits 1,2,3
    // S2 covers edits 1,2,3,4,5
    // S3 covers edits 1,2,3,4,5,6,7
    const snapshots: Snapshot[] = [
      {
        cid: fakeCid(1),
        state: new Uint8Array([1, 2, 3]),
      },
      {
        cid: fakeCid(2),
        state: new Uint8Array([1, 2, 3, 4, 5]),
      },
      {
        cid: fakeCid(3),
        state: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
      },
    ];

    const edits = [
      fakeEdit(1, "aa", "content", 100),
      fakeEdit(2, "aa", "content", 200),
      fakeEdit(3, "bb", "content", 300),
      fakeEdit(4, "bb", "content", 400),
      fakeEdit(5, "cc", "content", 500),
      fakeEdit(6, "cc", "content", 600),
      fakeEdit(7, "dd", "content", 700),
    ];

    const codec = fakeCodec();
    const result = backfillEdits(snapshots, edits, codec);
    const arr = toArray(result);

    // [1,2,3] S1 | [4,5] S2 | [6,7] S3
    expect(arr).toHaveLength(3);

    expect(arr[0]!.edits).toHaveLength(3);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");

    expect(arr[1]!.edits).toHaveLength(2);
    expect(arr[1]!.boundary.tag).toBe("snapshotted");

    expect(arr[2]!.edits).toHaveLength(2);
    expect(arr[2]!.boundary.tag).toBe("snapshotted");

    // Verify total index
    const idx = measureTree(epochMeasured, result);
    expect(idx.epochCount).toBe(3);
    expect(idx.editCount).toBe(7);
    expect(idx.snapshotCount).toBe(3);
    expect(idx.timeRange).toEqual([100, 700]);
    expect(idx.authors.size).toBe(4);
  });
});

// -- Property tests --

describe("backfillEdits properties", () => {
  it("all edits present after backfill", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (snapshotCount, editIds) => {
          const uniqueIds = [...new Set(editIds)];
          if (uniqueIds.length === 0) return;

          // Build ascending snapshot coverage
          const snapshots: Snapshot[] = [];
          const step = Math.max(
            1,
            Math.floor(uniqueIds.length / snapshotCount),
          );
          for (let i = 0; i < snapshotCount; i++) {
            const end = Math.min((i + 1) * step, uniqueIds.length);
            const covered = uniqueIds.slice(0, end);
            snapshots.push({
              cid: fakeCid(i + 1),
              state: new Uint8Array(covered),
            });
          }

          const edits = uniqueIds.map((id) =>
            fakeEdit(id, "aa", "content", id * 100),
          );

          const codec = fakeCodec();
          const result = backfillEdits(snapshots, edits, codec);
          const arr = toArray(result);

          // Collect all edit payloads from result
          const resultIds = new Set<number>();
          for (const ep of arr) {
            for (const e of ep.edits) {
              resultIds.add(e.payload[0]!);
            }
          }

          // All original IDs present
          for (const id of uniqueIds) {
            expect(resultIds.has(id)).toBe(true);
          }
          // No extra IDs
          expect(resultIds.size).toBe(uniqueIds.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("each edit is in the correct epoch", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (snapshotCount, editIds) => {
          const uniqueIds = [...new Set(editIds)];
          if (uniqueIds.length === 0) return;

          const snapshots: Snapshot[] = [];
          const step = Math.max(
            1,
            Math.floor(uniqueIds.length / snapshotCount),
          );
          for (let i = 0; i < snapshotCount; i++) {
            const end = Math.min((i + 1) * step, uniqueIds.length);
            const covered = uniqueIds.slice(0, end);
            snapshots.push({
              cid: fakeCid(i + 1),
              state: new Uint8Array(covered),
            });
          }

          const edits = uniqueIds.map((id) =>
            fakeEdit(id, "aa", "content", id * 100),
          );

          const codec = fakeCodec();
          const result = backfillEdits(snapshots, edits, codec);
          const arr = toArray(result);

          // For each epoch, verify placement:
          // edit in epoch[i] must be contained by
          // snapshot[i] but NOT by snapshot[i-1]
          for (let i = 0; i < arr.length; i++) {
            for (const e of arr[i]!.edits) {
              if (i < snapshots.length) {
                // Snapshotted epoch: must be contained
                expect(codec.contains(snapshots[i]!.state, e.payload)).toBe(
                  true,
                );
                // Must NOT be in previous snapshot
                if (i > 0) {
                  expect(
                    codec.contains(snapshots[i - 1]!.state, e.payload),
                  ).toBe(false);
                }
              } else {
                // Remainder epoch: not in any snapshot
                for (const s of snapshots) {
                  expect(codec.contains(s.state, e.payload)).toBe(false);
                }
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
