import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { toArray, measureTree } from "@pokapali/finger-tree";
import { Epoch, Boundary } from "./epoch.js";
import { Edit } from "./edit.js";
import { epochMeasured } from "./summary.js";
import { History } from "./history.js";
import type { Codec } from "@pokapali/codec";

// -- Helpers --

function fakeCid(n: number): CID {
  const bytes = new Uint8Array(32);
  bytes[0] = n;
  const digest = Digest.create(0x12, bytes);
  return CID.createV1(0x71, digest);
}

function fakeEdit(channel = "content", author = "aabb") {
  return Edit.create({
    payload: new Uint8Array([1, 2, 3]),
    timestamp: Date.now(),
    author,
    channel,
    origin: "local",
    signature: new Uint8Array([4, 5, 6]),
  });
}

function fakeEditWithId(
  id: number,
  author = "aabb",
  channel = "content",
  timestamp = Date.now(),
) {
  return Edit.create({
    payload: new Uint8Array([id]),
    timestamp,
    author,
    channel,
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

function fakeCodec(containedIds: Set<number>): Codec {
  return {
    merge: (a, b) => new Uint8Array([...a, ...b]),
    diff: (state, _base) => state,
    apply: (base, update) => new Uint8Array([...base, ...update]),
    empty: () => new Uint8Array([]),
    contains: (_snapshot, editPayload) => containedIds.has(editPayload[0]!),
  };
}

// -- Boundary companion --

describe("Boundary", () => {
  it("open boundary", () => {
    const b = Boundary.open();
    expect(b.tag).toBe("open");
  });

  it("closed boundary", () => {
    const b = Boundary.closed();
    expect(b.tag).toBe("closed");
  });

  it("snapshotted boundary holds CID", () => {
    const cid = fakeCid(1);
    const b = Boundary.snapshotted(cid);
    expect(b.tag).toBe("snapshotted");
    if (b.tag === "snapshotted") {
      expect(b.cid).toBe(cid);
    }
  });
});

// -- Epoch companion --

describe("Epoch.create", () => {
  it("constructs with edits and boundary", () => {
    const e1 = fakeEdit();
    const ep = Epoch.create([e1], Boundary.open());

    expect(ep.edits).toHaveLength(1);
    expect(ep.edits[0]).toBe(e1);
    expect(ep.boundary.tag).toBe("open");
  });

  it("empty edits represent opaque hydration", () => {
    const ep = Epoch.create([], Boundary.snapshotted(fakeCid(1)));
    expect(ep.edits).toHaveLength(0);
    expect(ep.boundary.tag).toBe("snapshotted");
  });
});

describe("Epoch.isOpen", () => {
  it("true for open boundary", () => {
    expect(Epoch.isOpen(Epoch.create([], Boundary.open()))).toBe(true);
  });

  it("false for closed boundary", () => {
    expect(Epoch.isOpen(Epoch.create([], Boundary.closed()))).toBe(false);
  });
});

describe("Epoch.append", () => {
  it("adds edit to open epoch", () => {
    const ep = Epoch.create([], Boundary.open());
    const e1 = fakeEdit();
    const e2 = fakeEdit("comments");

    const after1 = Epoch.append(ep, e1);
    const after2 = Epoch.append(after1, e2);

    expect(after2.edits).toHaveLength(2);
    expect(after2.edits[0]).toBe(e1);
    expect(after2.edits[1]).toBe(e2);
  });

  it("does not mutate original", () => {
    const ep = Epoch.create([], Boundary.open());
    Epoch.append(ep, fakeEdit());
    expect(ep.edits).toHaveLength(0);
  });

  it("throws on closed epoch", () => {
    const ep = Epoch.create([], Boundary.closed());
    expect(() => Epoch.append(ep, fakeEdit())).toThrow(
      "Cannot append edit to a non-open epoch",
    );
  });
});

describe("Epoch.close", () => {
  it("open -> closed", () => {
    const ep = Epoch.create([fakeEdit()], Boundary.open());
    const closed = Epoch.close(ep);

    expect(closed.boundary.tag).toBe("closed");
    expect(closed.edits).toHaveLength(1);
  });

  it("throws if not open", () => {
    const ep = Epoch.create([], Boundary.closed());
    expect(() => Epoch.close(ep)).toThrow("Can only close an open epoch");
  });
});

describe("Epoch.snapshot", () => {
  it("closed -> snapshotted", () => {
    const ep = Epoch.create([], Boundary.closed());
    const cid = fakeCid(5);
    const snapped = Epoch.snapshot(ep, cid);

    expect(snapped.boundary.tag).toBe("snapshotted");
    if (snapped.boundary.tag === "snapshotted") {
      expect(snapped.boundary.cid).toBe(cid);
    }
  });

  it("throws if open", () => {
    const ep = Epoch.create([], Boundary.open());
    expect(() => Epoch.snapshot(ep, fakeCid(1))).toThrow(
      "Cannot snapshot an open epoch",
    );
  });
});

describe("Epoch.merge", () => {
  it("unions edits from both epochs", () => {
    const e1 = fakeEdit("content", "aa");
    const e2 = fakeEdit("comments", "bb");
    const e3 = fakeEdit("content", "cc");

    const a = Epoch.create([e1, e2], Boundary.closed());
    const b = Epoch.create([e3], Boundary.closed());

    const merged = Epoch.merge(a, b);
    expect(merged.edits).toHaveLength(3);
    expect(merged.edits).toContain(e1);
    expect(merged.edits).toContain(e2);
    expect(merged.edits).toContain(e3);
  });

  it("takes b's boundary", () => {
    const a = Epoch.create([fakeEdit()], Boundary.snapshotted(fakeCid(1)));
    const b = Epoch.create([fakeEdit()], Boundary.closed());

    const merged = Epoch.merge(a, b);
    expect(merged.boundary.tag).toBe("closed");
  });

  it("throws if a has open boundary", () => {
    const a = Epoch.create([fakeEdit()], Boundary.open());
    const b = Epoch.create([fakeEdit()], Boundary.closed());
    expect(() => Epoch.merge(a, b)).toThrow();
  });

  it("throws if b has open boundary", () => {
    const a = Epoch.create([fakeEdit()], Boundary.closed());
    const b = Epoch.create([fakeEdit()], Boundary.open());
    expect(() => Epoch.merge(a, b)).toThrow();
  });
});

describe("Epoch.splitAtSnapshot", () => {
  it("splits epoch at snapshot boundary", () => {
    const edits = [
      fakeEditWithId(1, "aa", "content", 100),
      fakeEditWithId(2, "bb", "content", 200),
      fakeEditWithId(3, "cc", "content", 300),
      fakeEditWithId(4, "dd", "content", 400),
    ];
    const ep = Epoch.create(edits, Boundary.closed());
    const tree = History.fromEpochs([ep]);
    const cid = fakeCid(1);
    const codec = fakeCodec(new Set([1, 2]));
    const snapshot = new Uint8Array([1, 2]);

    const result = Epoch.splitAtSnapshot(tree, 1, snapshot, cid, codec);
    const arr = toArray(result);

    expect(arr).toHaveLength(2);
    expect(arr[0]!.edits).toHaveLength(2);
    expect(arr[0]!.boundary.tag).toBe("snapshotted");
    expect(arr[1]!.edits).toHaveLength(2);
    expect(arr[1]!.boundary.tag).toBe("closed");
  });

  it("throws if target epoch is open", () => {
    const ep = Epoch.create([fakeEditWithId(1)], Boundary.open());
    const tree = History.fromEpochs([ep]);
    const codec = fakeCodec(new Set([1]));

    expect(() =>
      Epoch.splitAtSnapshot(tree, 1, new Uint8Array([1]), fakeCid(1), codec),
    ).toThrow();
  });

  it("throws for invalid position", () => {
    const tree = History.fromEpochs([
      Epoch.create([fakeEditWithId(1)], Boundary.closed()),
    ]);
    const codec = fakeCodec(new Set());

    expect(() =>
      Epoch.splitAtSnapshot(tree, 0, new Uint8Array([]), fakeCid(1), codec),
    ).toThrow();
  });
});
