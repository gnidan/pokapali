import { describe, it, expect } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import type { Epoch } from "#history";
import { Epoch as EpochCompanion, Boundary, Edit, History } from "#history";
import { Cache, foldTree } from "../view.js";
import { view, channelMeasured } from "./view.js";

// -- Helpers --

function fakeEdit(
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

// -- Per-channel Measured tests --

describe("Fingerprint.channelMeasured", () => {
  it("empty tree → 32 zero bytes", () => {
    const m = channelMeasured();
    const tree = History.fromEpochs([]);
    const cache = Cache.create<Uint8Array>();
    const result = foldTree(m, tree, cache);

    expect(result).toEqual(new Uint8Array(32));
  });

  it("single edit → non-zero hash", () => {
    const m = channelMeasured();
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const cache = Cache.create<Uint8Array>();
    const result = foldTree(m, tree, cache);

    expect(result.length).toBe(32);
    const allZero = result.every((b) => b === 0);
    expect(allZero).toBe(false);
  });

  it("order-independent: same edits," + " different order", () => {
    const m = channelMeasured();
    const tree1 = History.fromEpochs([
      EpochCompanion.create(
        [fakeEdit(1), fakeEdit(2), fakeEdit(3)],
        Boundary.closed(),
      ),
    ]);
    const tree2 = History.fromEpochs([
      EpochCompanion.create(
        [fakeEdit(3), fakeEdit(1), fakeEdit(2)],
        Boundary.closed(),
      ),
    ]);
    const c1 = Cache.create<Uint8Array>();
    const c2 = Cache.create<Uint8Array>();

    expect(foldTree(m, tree1, c1)).toEqual(foldTree(m, tree2, c2));
  });

  it("boundary-independent: same edits," + " different epochs", () => {
    const m = channelMeasured();
    const tree1 = History.fromEpochs([
      EpochCompanion.create(
        [fakeEdit(1), fakeEdit(2), fakeEdit(3)],
        Boundary.closed(),
      ),
    ]);
    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(2), fakeEdit(3)], Boundary.closed()),
    ]);
    const c1 = Cache.create<Uint8Array>();
    const c2 = Cache.create<Uint8Array>();

    expect(foldTree(m, tree1, c1)).toEqual(foldTree(m, tree2, c2));
  });

  it("different edits → different hash", () => {
    const m = channelMeasured();
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(2)], Boundary.closed()),
    ]);
    const c1 = Cache.create<Uint8Array>();
    const c2 = Cache.create<Uint8Array>();

    const h1 = foldTree(m, tree1, c1);
    const h2 = foldTree(m, tree2, c2);

    expect(h1).not.toEqual(h2);
  });
});

// -- Multi-channel View tests --

describe("Fingerprint.view", () => {
  it("has correct name", () => {
    const v = view();
    expect(v.name).toBe("content-hash");
  });

  it("spans content and comments channels", () => {
    const v = view();
    expect(Object.keys(v.channels).sort()).toEqual(["comments", "content"]);
  });

  it("combine XORs both channel results", () => {
    const v = view();

    // Two known 32-byte arrays
    const a = new Uint8Array(32).fill(0xaa);
    const b = new Uint8Array(32).fill(0x55);

    const result = v.combine({
      content: a,
      comments: b,
    });

    // 0xAA ^ 0x55 = 0xFF
    expect(result).toEqual(new Uint8Array(32).fill(0xff));
  });

  it("combine with one empty channel" + " equals the other", () => {
    const v = view();
    const m = channelMeasured();
    const hash = new Uint8Array(32).fill(0x42);
    const empty = m.monoid.empty;

    const result = v.combine({
      content: hash,
      comments: empty,
    });

    expect(result).toEqual(hash);
  });

  it("per-channel evaluation via" + " channel measured works", () => {
    const v = view();
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    // Evaluate content channel directly
    const contentM = v.channels.content! as Measured<Uint8Array, Epoch>;
    const cache = Cache.create<Uint8Array>();
    const result = foldTree(contentM, tree, cache);

    expect(result.length).toBe(32);
    expect(result.every((b: number) => b === 0)).toBe(false);
  });
});
