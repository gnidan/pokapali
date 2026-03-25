import { describe, it, expect, vi } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import type { Epoch } from "../history/epoch.js";
import { Epoch as EpochCompanion, Boundary } from "../history/epoch.js";
import { Edit } from "../history/edit.js";
import { History } from "../history/history.js";
import { View } from "../view.js";
import { Registry } from "./registry.js";

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

const maxIdView = View.create({
  name: "max-id",
  description: "Max edit payload byte",
  measured: {
    monoid: {
      empty: 0,
      append: (a: number, b: number) => Math.max(a, b),
    },
    measure: (ep: Epoch) =>
      ep.edits.reduce((m, e) => Math.max(m, e.payload[0] ?? 0), 0),
  },
});

// -- Tests --

describe("Registry.create", () => {
  it("starts with no active views", () => {
    const tree = History.fromEpochs([]);
    const registry = Registry.create(tree);

    expect(registry.isActive("edit-count")).toBe(false);
  });

  it("activate returns feed with ready snapshot", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
    ]);

    const registry = Registry.create(tree);
    const feed = registry.activate(editCountView);
    const state = feed.getSnapshot();

    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(2);
    }
  });

  it("activate marks view as active", () => {
    const tree = History.fromEpochs([]);
    const registry = Registry.create(tree);
    registry.activate(editCountView);

    expect(registry.isActive("edit-count")).toBe(true);
  });

  it("activate is idempotent", () => {
    const tree = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    const registry = Registry.create(tree);
    const feed1 = registry.activate(editCountView);
    const feed2 = registry.activate(editCountView);

    expect(feed1).toBe(feed2);
  });

  it("notifyTreeChanged propagates to all feeds", () => {
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    const registry = Registry.create(tree1);
    const countFeed = registry.activate(editCountView);
    const maxFeed = registry.activate(maxIdView);

    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
      EpochCompanion.create([fakeEdit(5), fakeEdit(3)], Boundary.closed()),
    ]);
    registry.notifyTreeChanged(tree2);

    const countState = countFeed.getSnapshot();
    if (countState.tag === "ready") {
      expect(countState.value).toBe(3);
    }
    const maxState = maxFeed.getSnapshot();
    if (maxState.tag === "ready") {
      expect(maxState.value).toBe(5);
    }
  });

  it("deactivate removes view", () => {
    const tree = History.fromEpochs([]);
    const registry = Registry.create(tree);
    registry.activate(editCountView);
    registry.deactivate("edit-count");

    expect(registry.isActive("edit-count")).toBe(false);
  });

  it("deactivate stops feed notifications", () => {
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);

    const registry = Registry.create(tree1);
    const feed = registry.activate(editCountView);
    const cb = vi.fn();
    feed.subscribe(cb);
    registry.deactivate("edit-count");

    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
    ]);
    registry.notifyTreeChanged(tree2);

    expect(cb).not.toHaveBeenCalled();
  });

  it("destroy clears all feeds", () => {
    const tree = History.fromEpochs([]);
    const registry = Registry.create(tree);
    registry.activate(editCountView);
    registry.activate(maxIdView);
    registry.destroy();

    expect(registry.isActive("edit-count")).toBe(false);
    expect(registry.isActive("max-id")).toBe(false);
  });

  it("activate after deactivate creates fresh feed", () => {
    const tree1 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1)], Boundary.closed()),
    ]);
    const registry = Registry.create(tree1);
    const feed1 = registry.activate(editCountView);

    const tree2 = History.fromEpochs([
      EpochCompanion.create([fakeEdit(1), fakeEdit(2)], Boundary.closed()),
    ]);
    registry.notifyTreeChanged(tree2);

    registry.deactivate("edit-count");
    const feed2 = registry.activate(editCountView);

    expect(feed2).not.toBe(feed1);
    const state = feed2.getSnapshot();
    if (state.tag === "ready") {
      expect(state.value).toBe(2);
    }
  });
});
