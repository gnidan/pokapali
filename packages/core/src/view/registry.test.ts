import { describe, it, expect, vi } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import { fromEpochs } from "../epoch/tree.js";
import { edit, epoch, closedBoundary } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";
import { monoidalView } from "./types.js";
import { createViewRegistry } from "./registry.js";

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
  measured: editCountMeasured,
});

const maxIdMeasured: Measured<number, Epoch> = {
  monoid: {
    empty: 0,
    append: (a, b) => Math.max(a, b),
  },
  measure: (ep) =>
    ep.edits.reduce((max, e) => Math.max(max, e.payload[0] ?? 0), 0),
};

const maxIdView = monoidalView({
  name: "max-id",
  description: "Maximum edit ID",
  measured: maxIdMeasured,
});

// -- Tests --

describe("createViewRegistry", () => {
  it("activate returns a feed in ready state", () => {
    const tree = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
    ]);

    const registry = createViewRegistry(tree);
    const feed = registry.activate(editCountView);
    const state = feed.getSnapshot();

    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(2);
    }
  });

  it("activate twice returns the same feed", () => {
    const tree = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const registry = createViewRegistry(tree);
    const feed1 = registry.activate(editCountView);
    const feed2 = registry.activate(editCountView);

    expect(feed1).toBe(feed2);
  });

  it("deactivate makes isActive return false", () => {
    const tree = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const registry = createViewRegistry(tree);
    registry.activate(editCountView);
    expect(registry.isActive("edit-count")).toBe(true);

    registry.deactivate("edit-count");
    expect(registry.isActive("edit-count")).toBe(false);
  });

  it("notifyTreeChanged propagates to active feeds", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const registry = createViewRegistry(tree1);
    const feed = registry.activate(editCountView);

    const cb = vi.fn();
    feed.subscribe(cb);

    const tree2 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
    ]);
    registry.notifyTreeChanged(tree2);

    // stale + ready = 2 notifications
    expect(cb).toHaveBeenCalledTimes(2);

    const state = feed.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(2);
    }
  });

  it("activate after deactivate returns fresh feed", () => {
    const tree = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const registry = createViewRegistry(tree);
    const feed1 = registry.activate(editCountView);
    registry.deactivate("edit-count");
    const feed2 = registry.activate(editCountView);

    expect(feed2).not.toBe(feed1);

    const state = feed2.getSnapshot();
    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(1);
    }
  });

  it("destroy deactivates all views", () => {
    const tree = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const registry = createViewRegistry(tree);
    registry.activate(editCountView);
    registry.activate(maxIdView);

    expect(registry.isActive("edit-count")).toBe(true);
    expect(registry.isActive("max-id")).toBe(true);

    registry.destroy();

    expect(registry.isActive("edit-count")).toBe(false);
    expect(registry.isActive("max-id")).toBe(false);
  });

  it("deactivate during notifyTreeChanged does not throw", () => {
    const tree1 = fromEpochs([epoch([fakeEdit(1)], closedBoundary())]);

    const registry = createViewRegistry(tree1);
    const feed = registry.activate(editCountView);
    registry.activate(maxIdView);

    // Subscriber deactivates edit-count during notification
    feed.subscribe(() => {
      registry.deactivate("edit-count");
    });

    const tree2 = fromEpochs([
      epoch([fakeEdit(1)], closedBoundary()),
      epoch([fakeEdit(2)], closedBoundary()),
    ]);

    // Should not throw despite mutation during iteration
    expect(() => registry.notifyTreeChanged(tree2)).not.toThrow();

    // edit-count should be deactivated
    expect(registry.isActive("edit-count")).toBe(false);
    // max-id should still be active and updated
    expect(registry.isActive("max-id")).toBe(true);
  });

  it("multiple views have independent caches", () => {
    const tree1 = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
    ]);

    const registry = createViewRegistry(tree1);
    const countFeed = registry.activate(editCountView);
    const maxFeed = registry.activate(maxIdView);

    const countState = countFeed.getSnapshot();
    const maxState = maxFeed.getSnapshot();

    expect(countState.tag).toBe("ready");
    expect(maxState.tag).toBe("ready");

    if (countState.tag === "ready") {
      expect(countState.value).toBe(2);
    }
    if (maxState.tag === "ready") {
      expect(maxState.value).toBe(2);
    }

    // Update — both should reflect new tree
    const tree2 = fromEpochs([
      epoch([fakeEdit(1), fakeEdit(2)], closedBoundary()),
      epoch([fakeEdit(5)], closedBoundary()),
    ]);
    registry.notifyTreeChanged(tree2);

    const countState2 = countFeed.getSnapshot();
    const maxState2 = maxFeed.getSnapshot();

    if (countState2.tag === "ready") {
      expect(countState2.value).toBe(3);
    }
    if (maxState2.tag === "ready") {
      expect(maxState2.value).toBe(5);
    }
  });
});
