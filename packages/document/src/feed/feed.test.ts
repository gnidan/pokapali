import { describe, it, expect, vi } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import { snoc } from "@pokapali/finger-tree";
import type { Epoch } from "#history";
import {
  Epoch as EpochCompanion,
  Boundary,
  Edit,
  History,
  epochMeasured,
} from "#history";
import { Feed } from "./feed.js";

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

// -- Feed tests --

describe("Feed.create", () => {
  it("creates feed in ready state", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
    ]);

    const feed = Feed.create(editCountMeasured, tree);
    const state = feed.getSnapshot();

    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(2);
    }
  });

  it("subscribe receives callback on update", () => {
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    const feed = Feed.create(editCountMeasured, tree1);
    const cb = vi.fn();
    feed.subscribe(cb);

    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(2)], Boundary.closed()),
    ]);
    feed.update(tree2);

    expect(cb).toHaveBeenCalled();
  });

  it("update triggers stale then ready", () => {
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    const feed = Feed.create(editCountMeasured, tree1);
    const snapshots: string[] = [];
    feed.subscribe(() => {
      snapshots.push(feed.getSnapshot().tag);
    });

    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(2), fakeEdit(3)], Boundary.closed()),
    ]);
    feed.update(tree2);

    expect(snapshots).toEqual(["stale", "ready"]);
    const state = feed.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(3);
    }
  });

  it("structural sharing: cache hits", () => {
    const measureSpy = vi.fn((ep: Epoch) => ep.edits.length);
    const spiedMeasured: Measured<number, Epoch> = {
      monoid: {
        empty: 0,
        append: (a: number, b: number) => a + b,
      },
      measure: measureSpy,
    };

    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(2)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(3)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(4)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(5)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(6)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(7)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(8)], Boundary.closed()),
    ]);

    const feed = Feed.create(spiedMeasured, tree1);
    const firstCalls = measureSpy.mock.calls.length;
    expect(firstCalls).toBe(8);

    measureSpy.mockClear();
    const tree2 = snoc(
      epochMeasured,
      tree1,
      EpochCompanion.create([fakeEdit(9)], Boundary.open()),
    );
    feed.update(tree2);

    expect(measureSpy.mock.calls.length).toBeLessThan(firstCalls);

    const state = feed.getSnapshot();
    if (state.tag === "ready") {
      expect(state.value).toBe(9);
    }
  });

  it("destroy stops notifications", () => {
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    const feed = Feed.create(editCountMeasured, tree1);
    const cb = vi.fn();
    feed.subscribe(cb);
    feed.destroy();

    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(2)], Boundary.closed()),
    ]);
    feed.update(tree2);

    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops individual subscriber", () => {
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    const feed = Feed.create(editCountMeasured, tree1);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    feed.subscribe(cb1);
    const unsub2 = feed.subscribe(cb2);
    unsub2();

    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(2)], Boundary.closed()),
    ]);
    feed.update(tree2);

    expect(cb1).toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
