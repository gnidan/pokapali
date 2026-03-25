import { describe, it, expect } from "vitest";
import type { Codec } from "@pokapali/codec";
import { diff } from "./diff.js";

// -- Fake codec --

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

// -- Tests --

describe("diff", () => {
  it("no change → empty diff", () => {
    const state = new Uint8Array([1, 2, 3]);
    const result = diff(setCodec, state, state);

    expect(result).toEqual(new Uint8Array([]));
  });

  it("additions appear in diff", () => {
    const before = new Uint8Array([1, 2]);
    const after = new Uint8Array([1, 2, 3, 4]);
    const result = diff(setCodec, before, after);

    expect(result).toEqual(new Uint8Array([3, 4]));
  });

  it("empty before → full after is diff", () => {
    const before = new Uint8Array([]);
    const after = new Uint8Array([1, 2]);
    const result = diff(setCodec, before, after);

    expect(result).toEqual(new Uint8Array([1, 2]));
  });

  it("delegates to codec.diff(after, before)", () => {
    const before = new Uint8Array([1]);
    const after = new Uint8Array([1, 5]);
    const result = diff(setCodec, before, after);

    // codec.diff(state=after, base=before) → [5]
    expect(result).toEqual(new Uint8Array([5]));
  });
});
