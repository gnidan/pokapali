import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import type { Measured } from "@pokapali/finger-tree";
import { foldl } from "@pokapali/finger-tree";
import type { Epoch } from "./history/epoch.js";
import { Epoch as EpochCompanion, Boundary } from "./history/epoch.js";
import { Edit } from "./history/edit.js";
import { History } from "./history/history.js";
import { epochMeasured } from "./history/summary.js";
import { View, Status, Cache, inspect } from "./view.js";

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

const editCountMeasured: Measured<number, Epoch> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (ep) => ep.edits.length,
};

const editCountView = View.create({
  name: "edit-count",
  description: "Total edit count",
  measured: editCountMeasured,
});

// -- View.create tests --

describe("View.create", () => {
  it("creates a view with metadata", () => {
    const view = View.create({
      name: "epoch-count",
      description: "Counts epochs",
      measured: editCountMeasured,
    });

    expect(view.name).toBe("epoch-count");
    expect(view.description).toBe("Counts epochs");
    expect(view.measured).toBe(editCountMeasured);
  });

  it("measured field has correct monoid", () => {
    const view = View.create({
      name: "test",
      description: "test view",
      measured: editCountMeasured,
    });

    expect(view.measured.monoid.empty).toBe(0);
    expect(view.measured.monoid.append(2, 3)).toBe(5);
  });
});

// -- Status tests --

describe("Status", () => {
  it("pending state", () => {
    const state = Status.pending<number>();
    expect(state.tag).toBe("pending");
  });

  it("computing state", () => {
    const state = Status.computing<number>();
    expect(state.tag).toBe("computing");
  });

  it("ready state carries value", () => {
    const state = Status.ready(42);
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(42);
    }
  });

  it("stale state carries lastValue", () => {
    const state = Status.stale("old-data");
    expect(state.tag).toBe("stale");
    if (state.tag === "stale") {
      expect(state.lastValue).toBe("old-data");
    }
  });

  it("type narrowing across all variants", () => {
    const states: Status<number>[] = [
      Status.pending(),
      Status.computing(),
      Status.ready(99),
      Status.stale(50),
    ];
    const tags = states.map((s) => s.tag);
    expect(tags).toEqual(["pending", "computing", "ready", "stale"]);
  });
});

// -- Cache tests --

describe("Cache", () => {
  it("Cache.create returns empty cache", () => {
    const cache = Cache.create<number>();
    expect(cache).toBeDefined();
  });

  it("Cache.seed pre-populates", () => {
    const measureSpy = vi.fn((ep: Epoch) => ep.edits.length);
    const spiedView = View.create({
      name: "spied",
      description: "Spied edit count",
      measured: {
        monoid: {
          empty: 0,
          append: (a: number, b: number) => a + b,
        },
        measure: measureSpy,
      },
    });

    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(3)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(4), fakeEdit(5)], Boundary.closed()),
    ]);

    const cache = Cache.create<number>();
    Cache.seed(cache, tree, 5);

    const result = inspect(spiedView, tree, cache);
    expect(result).toBe(5);
    expect(measureSpy).not.toHaveBeenCalled();
  });
});

// -- inspect tests --

describe("inspect", () => {
  it("empty tree → monoid identity", () => {
    const tree = History.fromEpochs([]);
    const cache = Cache.create<number>();
    expect(inspect(editCountView, tree, cache)).toBe(0);
  });

  it("single epoch", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create(
        [fakeEdit(1), fakeEdit(2), fakeEdit(3)],
        Boundary.closed(),
      ),
    ]);
    const cache = Cache.create<number>();
    expect(inspect(editCountView, tree, cache)).toBe(3);
  });

  it("multiple epochs", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(3)], Boundary.closed()),
      EpochCompanion.create(
        [fakeEdit(4), fakeEdit(5), fakeEdit(6)],
        Boundary.closed(),
      ),
      EpochCompanion.create([], Boundary.open()),
    ]);
    const cache = Cache.create<number>();
    expect(inspect(editCountView, tree, cache)).toBe(6);
  });

  it("cache hit avoids recomputation", () => {
    const measureSpy = vi.fn((ep: Epoch) => ep.edits.length);
    const spiedView = View.create({
      name: "spied",
      description: "Spied edit count",
      measured: {
        monoid: {
          empty: 0,
          append: (a: number, b: number) => a + b,
        },
        measure: measureSpy,
      },
    });

    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(3)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(4), fakeEdit(5)], Boundary.closed()),
    ]);

    const cache = Cache.create<number>();
    inspect(spiedView, tree, cache);
    expect(measureSpy).toHaveBeenCalledTimes(3);

    measureSpy.mockClear();
    inspect(spiedView, tree, cache);
    expect(measureSpy).not.toHaveBeenCalled();
  });
});

// -- inspect with { at } --

describe("inspect with { at }", () => {
  it("position 0 → monoid identity", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const cache = Cache.create<number>();
    expect(inspect(editCountView, tree, cache, { at: 0 })).toBe(0);
  });

  it("position 1 → first epoch only", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(3)], Boundary.closed()),
    ]);
    const cache = Cache.create<number>();
    expect(inspect(editCountView, tree, cache, { at: 1 })).toBe(2);
  });

  it("position = all → same as full", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(2)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(3)], Boundary.closed()),
    ]);
    const cache = Cache.create<number>();
    expect(inspect(editCountView, tree, cache, { at: 3 })).toBe(
      inspect(editCountView, tree, cache),
    );
  });

  it("position beyond tree → full evaluation", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const cache = Cache.create<number>();
    expect(
      inspect(editCountView, tree, cache, {
        at: 10,
      }),
    ).toBe(inspect(editCountView, tree, cache));
  });
});

// -- Property tests --

describe("inspect properties", () => {
  const arbEpoch = fc
    .record({
      editCount: fc.integer({ min: 0, max: 10 }),
      author: fc.constantFrom("aa", "bb", "cc"),
      timestamp: fc.integer({
        min: 0,
        max: 1_000_000,
      }),
    })
    .map(({ editCount, author, timestamp }) =>
      EpochCompanion.create(
        Array.from({ length: editCount }, (_, i) =>
          fakeEdit(i + 1, author, "content", timestamp + i),
        ),
        Boundary.closed(),
      ),
    );

  it("inspect = naive foldl over toArray", () => {
    fc.assert(
      fc.property(
        fc.array(arbEpoch, {
          minLength: 0,
          maxLength: 20,
        }),
        (epochs) => {
          const tree = History.fromEpochs(epochs);
          const cache = Cache.create<number>();
          const evaluated = inspect(editCountView, tree, cache);
          const naive = foldl(
            tree,
            (acc: number, ep: Epoch) =>
              editCountMeasured.monoid.append(
                acc,
                editCountMeasured.measure(ep),
              ),
            editCountMeasured.monoid.empty,
          );
          expect(evaluated).toBe(naive);
        },
      ),
      { numRuns: 200 },
    );
  });
});
