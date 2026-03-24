import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import {
  edit,
  epoch,
  appendEdit,
  isOpen,
  closeEpoch,
  snapshotEpoch,
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

function fakeEdit(channel = "content", author = "aabb") {
  return edit({
    payload: new Uint8Array([1, 2, 3]),
    timestamp: Date.now(),
    author,
    channel,
    origin: "local",
    signature: new Uint8Array([4, 5, 6]),
  });
}

// -- Tests --

describe("Edit", () => {
  it("constructs with all fields", () => {
    const e = edit({
      payload: new Uint8Array([1, 2]),
      timestamp: 1000,
      author: "aabb",
      channel: "content",
      origin: "local",
      signature: new Uint8Array([3, 4]),
    });

    expect(e.payload).toEqual(new Uint8Array([1, 2]));
    expect(e.timestamp).toBe(1000);
    expect(e.author).toBe("aabb");
    expect(e.channel).toBe("content");
    expect(e.origin).toBe("local");
    expect(e.signature).toEqual(new Uint8Array([3, 4]));
  });

  it("supports all origin types", () => {
    for (const origin of ["local", "sync", "hydrate"] as const) {
      const e = edit({
        payload: new Uint8Array([1]),
        timestamp: 1000,
        author: "aa",
        channel: "content",
        origin,
        signature: new Uint8Array([]),
      });
      expect(e.origin).toBe(origin);
    }
  });
});

describe("EpochBoundary", () => {
  it("open boundary", () => {
    const b = openBoundary();
    expect(b.tag).toBe("open");
  });

  it("closed boundary", () => {
    const b = closedBoundary();
    expect(b.tag).toBe("closed");
  });

  it("snapshotted boundary holds CID", () => {
    const cid = fakeCid(1);
    const b = snapshottedBoundary(cid);
    expect(b.tag).toBe("snapshotted");
    if (b.tag === "snapshotted") {
      expect(b.cid).toBe(cid);
    }
  });
});

describe("Epoch", () => {
  it("constructs with edits and boundary", () => {
    const e1 = fakeEdit();
    const ep = epoch([e1], openBoundary());

    expect(ep.edits).toHaveLength(1);
    expect(ep.edits[0]).toBe(e1);
    expect(ep.boundary.tag).toBe("open");
  });

  it("empty edits represent opaque hydration", () => {
    const ep = epoch([], snapshottedBoundary(fakeCid(1)));
    expect(ep.edits).toHaveLength(0);
    expect(ep.boundary.tag).toBe("snapshotted");
  });
});

describe("isOpen", () => {
  it("true for open boundary", () => {
    expect(isOpen(epoch([], openBoundary()))).toBe(true);
  });

  it("false for closed boundary", () => {
    expect(isOpen(epoch([], closedBoundary()))).toBe(false);
  });

  it("false for snapshotted boundary", () => {
    expect(isOpen(epoch([], snapshottedBoundary(fakeCid(1))))).toBe(false);
  });
});

describe("appendEdit", () => {
  it("adds edit to open epoch", () => {
    const ep = epoch([], openBoundary());
    const e1 = fakeEdit();
    const e2 = fakeEdit("comments");

    const after1 = appendEdit(ep, e1);
    const after2 = appendEdit(after1, e2);

    expect(after2.edits).toHaveLength(2);
    expect(after2.edits[0]).toBe(e1);
    expect(after2.edits[1]).toBe(e2);
  });

  it("does not mutate original", () => {
    const ep = epoch([], openBoundary());
    const e1 = fakeEdit();
    appendEdit(ep, e1);
    expect(ep.edits).toHaveLength(0);
  });

  it("throws on closed epoch", () => {
    const ep = epoch([], closedBoundary());
    expect(() => appendEdit(ep, fakeEdit())).toThrow(
      "Cannot append edit to a non-open epoch",
    );
  });

  it("throws on snapshotted epoch", () => {
    const ep = epoch([], snapshottedBoundary(fakeCid(1)));
    expect(() => appendEdit(ep, fakeEdit())).toThrow(
      "Cannot append edit to a non-open epoch",
    );
  });
});

describe("boundary transitions", () => {
  it("open → closed via closeEpoch", () => {
    const ep = epoch([fakeEdit()], openBoundary());
    const closed = closeEpoch(ep);

    expect(closed.boundary.tag).toBe("closed");
    expect(closed.edits).toHaveLength(1);
  });

  it("closeEpoch throws if not open", () => {
    const ep = epoch([], closedBoundary());
    expect(() => closeEpoch(ep)).toThrow("Can only close an open epoch");
  });

  it("closed → snapshotted via snapshotEpoch", () => {
    const ep = epoch([], closedBoundary());
    const cid = fakeCid(5);
    const snapped = snapshotEpoch(ep, cid);

    expect(snapped.boundary.tag).toBe("snapshotted");
    if (snapped.boundary.tag === "snapshotted") {
      expect(snapped.boundary.cid).toBe(cid);
    }
  });

  it("snapshotEpoch throws if open", () => {
    const ep = epoch([], openBoundary());
    expect(() => snapshotEpoch(ep, fakeCid(1))).toThrow(
      "Cannot snapshot an open epoch",
    );
  });

  it("open → closed → snapshotted chain", () => {
    let ep = epoch([fakeEdit()], openBoundary());
    expect(ep.boundary.tag).toBe("open");

    ep = closeEpoch(ep);
    expect(ep.boundary.tag).toBe("closed");

    ep = snapshotEpoch(ep, fakeCid(1));
    expect(ep.boundary.tag).toBe("snapshotted");
  });

  it("snapshotEpoch preserves edits", () => {
    const e1 = fakeEdit();
    const ep = epoch([e1], closedBoundary());
    const snapped = snapshotEpoch(ep, fakeCid(1));
    expect(snapped.edits[0]).toBe(e1);
  });
});

describe("epoch chain (trailing boundaries)", () => {
  it("epochs carry only trailing boundary", () => {
    const ep1 = epoch([fakeEdit()], snapshottedBoundary(fakeCid(1)));
    const ep2 = epoch([fakeEdit()], snapshottedBoundary(fakeCid(2)));
    const ep3 = epoch([fakeEdit()], openBoundary());

    expect(ep1.boundary.tag).toBe("snapshotted");
    expect(ep2.boundary.tag).toBe("snapshotted");
    expect(ep3.boundary.tag).toBe("open");
  });

  it("multi-channel edits in same epoch", () => {
    const e1 = fakeEdit("content", "aa");
    const e2 = fakeEdit("comments", "bb");
    const e3 = fakeEdit("_meta", "cc");

    const ep = epoch([e1, e2, e3], closedBoundary());

    expect(ep.edits).toHaveLength(3);
    expect(ep.edits[0]!.channel).toBe("content");
    expect(ep.edits[1]!.channel).toBe("comments");
    expect(ep.edits[2]!.channel).toBe("_meta");
  });
});
