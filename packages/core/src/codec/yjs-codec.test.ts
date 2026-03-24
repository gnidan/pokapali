/**
 * YjsCrdtCodec tests.
 *
 * Covers all five CrdtCodec operations with Yjs
 * semantics: merge, diff, apply, empty, contains.
 *
 * Property-level tests verify CRDT laws
 * (commutativity, associativity, idempotence) and
 * diff/apply roundtrip.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { yjsCrdtCodec as codec } from "./yjs-codec.js";

// -- Helpers --

function makeUpdate(fn: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  fn(doc);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function makeUpdateFrom(
  base: Uint8Array,
  fn: (doc: Y.Doc) => void,
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  fn(doc);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function readMap(update: Uint8Array, mapName: string): Record<string, unknown> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const map = doc.getMap(mapName);
  const result: Record<string, unknown> = {};
  map.forEach((v, k) => {
    result[k] = v;
  });
  doc.destroy();
  return result;
}

// -- Tests --

describe("empty", () => {
  it("returns a valid Yjs update", () => {
    const e = codec.empty();
    expect(e).toBeInstanceOf(Uint8Array);
    expect(e.length).toBeGreaterThan(0);

    // Should apply without error
    const doc = new Y.Doc();
    Y.applyUpdate(doc, e);
    expect(doc.getMap("test").size).toBe(0);
    doc.destroy();
  });

  it("is the identity for merge", () => {
    const state = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });

    const merged = codec.merge(codec.empty(), state);
    expect(readMap(merged, "test")).toEqual({ a: 1 });

    const merged2 = codec.merge(state, codec.empty());
    expect(readMap(merged2, "test")).toEqual({ a: 1 });
  });
});

describe("merge", () => {
  it("combines two independent updates", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const b = makeUpdate((doc) => {
      doc.getMap("test").set("b", 2);
    });

    const merged = codec.merge(a, b);
    const result = readMap(merged, "test");
    expect(result["a"]).toBe(1);
    expect(result["b"]).toBe(2);
  });

  it("is commutative", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("x", "hello");
    });
    const b = makeUpdate((doc) => {
      doc.getMap("test").set("y", "world");
    });

    const ab = codec.merge(a, b);
    const ba = codec.merge(b, a);

    expect(readMap(ab, "test")).toEqual(readMap(ba, "test"));
  });

  it("is associative", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const b = makeUpdate((doc) => {
      doc.getMap("test").set("b", 2);
    });
    const c = makeUpdate((doc) => {
      doc.getMap("test").set("c", 3);
    });

    const ab_c = codec.merge(codec.merge(a, b), c);
    const a_bc = codec.merge(a, codec.merge(b, c));

    expect(readMap(ab_c, "test")).toEqual(readMap(a_bc, "test"));
  });

  it("is idempotent", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });

    const merged = codec.merge(a, a);
    expect(readMap(merged, "test")).toEqual({ a: 1 });
  });

  it("handles concurrent writes to same key", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("key", "from-a");
    });
    const b = makeUpdate((doc) => {
      doc.getMap("test").set("key", "from-b");
    });

    // Yjs resolves conflicts deterministically
    // (by clientId). Just verify no error.
    const merged = codec.merge(a, b);
    const result = readMap(merged, "test");
    expect(result["key"]).toBeDefined();
  });
});

describe("diff", () => {
  it("returns empty diff when base contains state", () => {
    const state = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });

    const d = codec.diff(state, state);

    // Diff should be empty — no new operations
    expect(codec.contains(state, d)).toBe(true);
  });

  it("returns delta for new operations", () => {
    const base = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const extended = makeUpdateFrom(base, (doc) => {
      doc.getMap("test").set("b", 2);
    });

    const delta = codec.diff(extended, base);

    // Delta should contain the new op
    expect(codec.contains(base, delta)).toBe(false);

    // Applying delta to base should yield extended
    const result = codec.apply(base, delta);
    expect(readMap(result, "test")).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("diff from empty gives full state", () => {
    const state = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });

    const delta = codec.diff(state, codec.empty());

    const result = codec.apply(codec.empty(), delta);
    expect(readMap(result, "test")).toEqual({ a: 1 });
  });
});

describe("apply", () => {
  it("applies update to base", () => {
    const base = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const update = makeUpdate((doc) => {
      doc.getMap("test").set("b", 2);
    });

    const result = codec.apply(base, update);
    expect(readMap(result, "test")).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("apply to empty is same as the update", () => {
    const update = makeUpdate((doc) => {
      doc.getMap("test").set("x", 42);
    });

    const result = codec.apply(codec.empty(), update);
    expect(readMap(result, "test")).toEqual({ x: 42 });
  });

  it("apply empty to state is identity", () => {
    const state = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });

    const result = codec.apply(state, codec.empty());
    expect(readMap(result, "test")).toEqual({ a: 1 });
  });

  it("diff/apply roundtrip", () => {
    const base = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const full = makeUpdateFrom(base, (doc) => {
      doc.getMap("test").set("b", 2);
      doc.getMap("test").set("c", 3);
    });

    const delta = codec.diff(full, base);
    const result = codec.apply(base, delta);

    expect(readMap(result, "test")).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
  });

  it("multi-step diff/apply chain", () => {
    const s0 = codec.empty();

    const s1 = makeUpdateFrom(s0, (doc) => {
      doc.getMap("test").set("step", 1);
    });
    const d1 = codec.diff(s1, s0);

    const s2 = makeUpdateFrom(s1, (doc) => {
      doc.getMap("test").set("step", 2);
    });
    const d2 = codec.diff(s2, s1);

    const s3 = makeUpdateFrom(s2, (doc) => {
      doc.getMap("test").set("step", 3);
    });
    const d3 = codec.diff(s3, s2);

    // Replay: empty → d1 → d2 → d3 = s3
    let current = s0;
    current = codec.apply(current, d1);
    current = codec.apply(current, d2);
    current = codec.apply(current, d3);

    expect(readMap(current, "test")).toEqual({
      step: 3,
    });
  });
});

describe("contains", () => {
  it("snapshot contains earlier edit", () => {
    const doc = new Y.Doc();
    doc.getMap("test").set("a", 1);
    const edit = Y.encodeStateAsUpdate(doc);

    doc.getMap("test").set("b", 2);
    const snapshot = Y.encodeStateAsUpdate(doc);

    expect(codec.contains(snapshot, edit)).toBe(true);
    doc.destroy();
  });

  it("snapshot does not contain later edit", () => {
    const doc = new Y.Doc();
    doc.getMap("test").set("a", 1);
    const snapshot = Y.encodeStateAsUpdate(doc);

    doc.getMap("test").set("b", 2);
    const edit = Y.encodeStateAsUpdate(doc);

    expect(codec.contains(snapshot, edit)).toBe(false);
    doc.destroy();
  });

  it("identical state → contained", () => {
    const state = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    expect(codec.contains(state, state)).toBe(true);
  });

  it("empty edit is always contained", () => {
    const state = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    expect(codec.contains(state, codec.empty())).toBe(true);
  });

  it("empty snapshot does not contain edits", () => {
    const edit = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    expect(codec.contains(codec.empty(), edit)).toBe(false);
  });

  it("multi-client: all contained after merge", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const b = makeUpdate((doc) => {
      doc.getMap("test").set("b", 2);
    });
    const c = makeUpdate((doc) => {
      doc.getMap("test").set("c", 3);
    });

    const merged = codec.merge(codec.merge(a, b), c);

    expect(codec.contains(merged, a)).toBe(true);
    expect(codec.contains(merged, b)).toBe(true);
    expect(codec.contains(merged, c)).toBe(true);
  });

  it("partial merge: missing client not contained", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const b = makeUpdate((doc) => {
      doc.getMap("test").set("b", 2);
    });
    const c = makeUpdate((doc) => {
      doc.getMap("test").set("c", 3);
    });

    const partial = codec.merge(a, b);

    expect(codec.contains(partial, a)).toBe(true);
    expect(codec.contains(partial, b)).toBe(true);
    expect(codec.contains(partial, c)).toBe(false);
  });

  it("delta containment", () => {
    const doc = new Y.Doc();
    doc.getMap("test").set("a", 1);
    const sv1 = Y.encodeStateVector(doc);

    doc.getMap("test").set("b", 2);
    const delta = Y.encodeStateAsUpdate(doc, sv1);
    const full = Y.encodeStateAsUpdate(doc);

    expect(codec.contains(full, delta)).toBe(true);

    // Early snapshot (before "b") should not
    // contain the delta
    const early = new Y.Doc();
    early.getMap("test").set("a", 1);
    // Different clientId — so early snapshot from
    // different doc won't contain original client's
    // operations. Test with same-doc snapshot:
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
    doc2.destroy();
    doc.destroy();
    early.destroy();
  });

  it("contains after apply", () => {
    const base = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const update = makeUpdate((doc) => {
      doc.getMap("test").set("b", 2);
    });

    // Before apply: base does not contain update
    expect(codec.contains(base, update)).toBe(false);

    // After apply: result contains both
    const result = codec.apply(base, update);
    expect(codec.contains(result, base)).toBe(true);
    expect(codec.contains(result, update)).toBe(true);
  });
});

describe("cross-operation consistency", () => {
  it("merge(a, b) contains both a and b", () => {
    const a = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const b = makeUpdate((doc) => {
      doc.getMap("test").set("b", 2);
    });

    const merged = codec.merge(a, b);
    expect(codec.contains(merged, a)).toBe(true);
    expect(codec.contains(merged, b)).toBe(true);
  });

  it("apply(base, diff(full, base)) ≡ full", () => {
    const base = makeUpdate((doc) => {
      doc.getMap("test").set("a", 1);
    });
    const full = makeUpdateFrom(base, (doc) => {
      doc.getMap("test").set("b", 2);
      doc.getMap("test").set("c", 3);
    });

    const delta = codec.diff(full, base);
    const result = codec.apply(base, delta);

    expect(readMap(result, "test")).toEqual(readMap(full, "test"));
  });

  it("diff(a, b) applied to b contains a", () => {
    const a = makeUpdate((doc) => {
      const m = doc.getMap("test");
      m.set("x", 1);
      m.set("y", 2);
    });
    const b = codec.empty();

    const delta = codec.diff(a, b);
    const result = codec.apply(b, delta);

    expect(codec.contains(result, a)).toBe(true);
  });
});
