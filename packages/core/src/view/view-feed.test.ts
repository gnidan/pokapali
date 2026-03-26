import { describe, it, expect, vi } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import { snoc } from "@pokapali/finger-tree";
import { epochMeasured } from "../epoch/index-monoid.js";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary, openBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import { createViewFeed } from "./view-feed.js";
import { monoidalView } from "./types.js";

// -- Helpers --

function fakeEdit(
  id: number,
  author = "aabb",
  channel = "content",
  timestamp = Date.now(),
) {
  return edit({
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

const editCountView = monoidalView({
  name: "edit-count",
  description: "Total edit count",
  channel: "content",
  measured: editCountMeasured,
});

// -- ViewFeed tests --

describe("createViewFeed", () => {
  it("creates feed in ready state", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
    ]);

    const feed = createViewFeed(editCountView, tree);
    const state = feed.getSnapshot();

    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(2);
    }
  });

  it("subscribe receives callback on update", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const feed = createViewFeed(editCountView, tree1);
    const cb = vi.fn();
    feed.subscribe(cb);

    const tree2 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
    ]);
    feed.update(tree2);

    expect(cb).toHaveBeenCalled();
  });

  it("update triggers stale then ready", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const feed = createViewFeed(editCountView, tree1);
    const snapshots: string[] = [];
    feed.subscribe(() => {
      snapshots.push(feed.getSnapshot().tag);
    });

    const tree2 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2), fakeEdit(3)], closedBoundary()),
    ]);
    feed.update(tree2);

    // Should see stale then ready
    expect(snapshots).toEqual(["stale", "ready"]);

    const state = feed.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(3);
    }
  });

  it("structural sharing: cache hits on shared subtrees", () => {
    const measureSpy = vi.fn((ep: Epoch) => ep.edits.length);
    const spiedView = monoidalView({
      name: "spied",
      description: "Spied edit count",
      channel: "content",
      measured: {
        monoid: {
          empty: 0,
          append: (a: number, b: number) => a + b,
        },
        measure: measureSpy,
      },
    });

    // 8 epochs for internal node sharing
    const tree1 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(3)], closedBoundary()),
      epoch([fakeEdit(4)], closedBoundary()),
      epoch([fakeEdit(5)], closedBoundary()),
      epoch([fakeEdit(6)], closedBoundary()),
      epoch([fakeEdit(7)], closedBoundary()),
      epoch([fakeEdit(8)], closedBoundary()),
    ]);

    const feed = createViewFeed(spiedView, tree1);
    const firstCalls = measureSpy.mock.calls.length;
    expect(firstCalls).toBe(8);

    // Snoc new epoch — shared subtrees should hit cache
    measureSpy.mockClear();
    const tree2 = snoc(
      epochMeasured,
      tree1,
      epoch([fakeEdit(9)], openBoundary()),
    );
    feed.update(tree2);

    expect(measureSpy.mock.calls.length).toBeLessThan(firstCalls);

    const state = feed.getSnapshot();
    if (state.tag === "ready") {
      expect(state.value).toBe(9);
    }
  });

  it("destroy stops notifications", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const feed = createViewFeed(editCountView, tree1);
    const cb = vi.fn();
    feed.subscribe(cb);
    feed.destroy();

    const tree2 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
    ]);
    feed.update(tree2);

    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple subscribers all notified", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const feed = createViewFeed(editCountView, tree1);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    feed.subscribe(cb1);
    feed.subscribe(cb2);
    feed.subscribe(cb3);

    const tree2 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
    ]);
    feed.update(tree2);

    // Each subscriber gets 2 notifications (stale + ready)
    expect(cb1).toHaveBeenCalledTimes(2);
    expect(cb2).toHaveBeenCalledTimes(2);
    expect(cb3).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops individual subscriber", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const feed = createViewFeed(editCountView, tree1);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    feed.subscribe(cb1);
    const unsub2 = feed.subscribe(cb2);

    unsub2();

    const tree2 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
    ]);
    feed.update(tree2);

    expect(cb1).toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
