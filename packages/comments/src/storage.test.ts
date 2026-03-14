import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import {
  commentsMap,
  readComment,
  writeComment,
  updateCommentData,
  deleteComment,
} from "./storage.js";
import type { Anchor } from "./anchor.js";

interface TestData {
  status: "open" | "resolved";
  priority: number;
}

function makeMap(): Y.Map<Y.Map<unknown>> {
  const doc = new Y.Doc();
  return commentsMap(doc);
}

function fakeAnchor(): Anchor {
  return {
    start: new Uint8Array([1, 2, 3]),
    end: new Uint8Array([4, 5, 6]),
  };
}

describe("commentsMap", () => {
  it("returns a Y.Map keyed by 'comments'", () => {
    const doc = new Y.Doc();
    const map = commentsMap(doc);
    expect(map).toBeInstanceOf(Y.Map);
    // Same reference on repeated calls.
    expect(commentsMap(doc)).toBe(map);
  });
});

describe("writeComment + readComment", () => {
  it("round-trips all fields", () => {
    const map = makeMap();
    const data: TestData = { status: "open", priority: 1 };
    const anchor = fakeAnchor();

    vi.spyOn(Date, "now").mockReturnValue(1000);
    writeComment(map, "c1", "alice", "hello", anchor, "p1", data);
    vi.restoreAllMocks();

    const entry = map.get("c1")!;
    expect(entry).toBeDefined();

    const stored = readComment<TestData>(entry);
    expect(stored).toEqual({
      id: "c1",
      author: "alice",
      content: "hello",
      ts: 1000,
      anchorStart: anchor.start,
      anchorEnd: anchor.end,
      parentId: "p1",
      data: { status: "open", priority: 1 },
    });
  });

  it("stores null anchor when none provided", () => {
    const map = makeMap();
    writeComment(map, "c2", "bob", "no anchor", undefined, undefined, {
      status: "open",
      priority: 0,
    });

    const stored = readComment<TestData>(map.get("c2")!);
    expect(stored.anchorStart).toBeNull();
    expect(stored.anchorEnd).toBeNull();
    expect(stored.parentId).toBeNull();
  });

  it("overwrites existing entry with same id", () => {
    const map = makeMap();
    writeComment(map, "c1", "alice", "first", undefined, undefined, {
      status: "open",
      priority: 0,
    });
    writeComment(map, "c1", "alice", "second", undefined, undefined, {
      status: "open",
      priority: 0,
    });

    const stored = readComment<TestData>(map.get("c1")!);
    expect(stored.content).toBe("second");
  });
});

describe("updateCommentData", () => {
  it("merges partial data", () => {
    const map = makeMap();
    writeComment(map, "c1", "alice", "hi", undefined, undefined, {
      status: "open",
      priority: 1,
    });

    updateCommentData<TestData>(map, "c1", {
      status: "resolved",
    });

    const stored = readComment<TestData>(map.get("c1")!);
    expect(stored.data.status).toBe("resolved");
    expect(stored.data.priority).toBe(1);
  });

  it("throws on non-existent comment", () => {
    const map = makeMap();
    expect(() =>
      updateCommentData<TestData>(map, "nope", {
        status: "resolved",
      }),
    ).toThrow(/not found/i);
  });
});

describe("deleteComment", () => {
  it("removes the entry", () => {
    const map = makeMap();
    writeComment(map, "c1", "alice", "bye", undefined, undefined, {
      status: "open",
      priority: 0,
    });
    expect(map.has("c1")).toBe(true);

    deleteComment(map, "c1");
    expect(map.has("c1")).toBe(false);
  });

  it("is idempotent on missing id", () => {
    const map = makeMap();
    expect(() => deleteComment(map, "nope")).not.toThrow();
  });
});
