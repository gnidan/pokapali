import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFeed } from "./use-feed.js";
import type { Feed } from "@pokapali/core";

interface WritableFeed<T> extends Feed<T> {
  _update(value: T): void;
}

function createFeed<T>(initial: T): WritableFeed<T> {
  let current = initial;
  const subs = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    _update(value: T) {
      current = value;
      for (const cb of subs) cb();
    },
  };
}

describe("useFeed", () => {
  it("returns initial snapshot", () => {
    const feed = createFeed(42);
    const { result } = renderHook(() => useFeed(feed));
    expect(result.current).toBe(42);
  });

  it("re-renders on update", () => {
    const feed = createFeed("a");
    const { result } = renderHook(() => useFeed(feed));

    act(() => feed._update("b"));
    expect(result.current).toBe("b");
  });

  it("no update after unmount", () => {
    const feed = createFeed(0);
    const { result, unmount } = renderHook(() => useFeed(feed));
    expect(result.current).toBe(0);

    unmount();
    // Should not throw.
    act(() => feed._update(1));
  });

  it("works with object values", () => {
    const feed = createFeed({ x: 1 });
    const { result } = renderHook(() => useFeed(feed));
    expect(result.current).toEqual({ x: 1 });

    const next = { x: 2 };
    act(() => feed._update(next));
    expect(result.current).toBe(next);
  });
});
