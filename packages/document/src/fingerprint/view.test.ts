import { describe, it, expect } from "vitest";
import { Epoch as EpochCompanion, Boundary } from "../history/epoch.js";
import { Edit } from "../history/edit.js";
import { History } from "../history/history.js";
import { Cache, inspect } from "../view.js";
import { view } from "./view.js";

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

// -- Tests --

describe("Fingerprint.view", () => {
  it("has correct name", () => {
    const v = view();
    expect(v.name).toBe("content-hash");
  });

  it("empty tree → 32 zero bytes", () => {
    const v = view();
    const tree = History.fromEpochs([]);
    const cache = Cache.create<Uint8Array>();
    const result = inspect(v, tree, cache);

    expect(result).toEqual(new Uint8Array(32));
  });

  it("single edit → non-zero hash", () => {
    const v = view();
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const cache = Cache.create<Uint8Array>();
    const result = inspect(v, tree, cache);

    expect(result.length).toBe(32);
    const allZero = result.every((b) => b === 0);
    expect(allZero).toBe(false);
  });

  it("order-independent: same edits, different order", () => {
    const v = view();
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

    expect(inspect(v, tree1, c1)).toEqual(inspect(v, tree2, c2));
  });

  it("boundary-independent: same edits, different epochs", () => {
    const v = view();
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

    expect(inspect(v, tree1, c1)).toEqual(inspect(v, tree2, c2));
  });

  it("different edits → different hash", () => {
    const v = view();
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(2)], Boundary.closed()),
    ]);
    const c1 = Cache.create<Uint8Array>();
    const c2 = Cache.create<Uint8Array>();

    const h1 = inspect(v, tree1, c1);
    const h2 = inspect(v, tree2, c2);

    expect(h1).not.toEqual(h2);
  });
});
