import { describe, it, expect } from "vitest";
import type { Codec } from "@pokapali/codec";
import { Epoch as EpochCompanion, Boundary, Edit, History } from "#history";
import { Cache, foldTree } from "../view.js";
import { view, channelMeasured } from "./view.js";

// -- Fake codec --

/**
 * Trivial set-union codec: each byte array is a set
 * of unique byte values. merge = union, diff = set
 * difference, empty = [].
 */
const setCodec: Codec = {
  merge(a, b) {
    const set = new Set([...a, ...b]);
    return new Uint8Array([...set].sort());
  },
  diff(state, base) {
    const baseSet = new Set(base);
    const delta = [...state].filter((x) => !baseSet.has(x));
    return new Uint8Array(delta);
  },
  apply(base, update) {
    return this.merge(base, update);
  },
  empty() {
    return new Uint8Array([]);
  },
  contains(snapshot, edit) {
    const snapSet = new Set(snapshot);
    return [...edit].every((x) => snapSet.has(x));
  },
};

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

describe("State.view", () => {
  it("has correct name", () => {
    const v = view(setCodec);
    expect(v.name).toBe("merged-payload");
  });

  it("empty tree → codec.empty()", () => {
    const m = channelMeasured(setCodec);
    const tree = History.fromEpochs([]);
    const cache = Cache.create<Uint8Array>();
    const result = foldTree(m, tree, cache);

    expect(result).toEqual(new Uint8Array([]));
  });

  it("single epoch merges payloads", () => {
    const m = channelMeasured(setCodec);
    const tree = History.fromEpochs([
      EpochCompanion.create(
        [fakeEdit(3), fakeEdit(1), fakeEdit(2)],
        Boundary.closed(),
      ),
    ]);
    const cache = Cache.create<Uint8Array>();
    const result = foldTree(m, tree, cache);

    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("multiple epochs fold left-to-right", () => {
    const m = channelMeasured(setCodec);
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(3)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(4), fakeEdit(5)], Boundary.closed()),
    ]);
    const cache = Cache.create<Uint8Array>();
    const result = foldTree(m, tree, cache);

    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("duplicate payloads are idempotent", () => {
    const m = channelMeasured(setCodec);
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const cache = Cache.create<Uint8Array>();
    const result = foldTree(m, tree, cache);

    expect(result).toEqual(new Uint8Array([1]));
  });
});
