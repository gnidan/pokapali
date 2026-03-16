import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDocReady } from "./use-doc-ready.js";
import type { Doc } from "@pokapali/core";

function mockDoc(readyPromise?: Promise<void>): Doc {
  return {
    ready: vi.fn(() => readyPromise ?? Promise.resolve()),
  } as unknown as Doc;
}

describe("useDocReady", () => {
  it("returns true after ready resolves", async () => {
    const doc = mockDoc(Promise.resolve());
    const { result } = renderHook(() => useDocReady(doc));

    // Initially may be false, resolves on next tick.
    await act(async () => {});
    expect(result.current).toBe(true);
  });

  it("returns false before ready resolves", () => {
    const doc = mockDoc(new Promise(() => {}));
    const { result } = renderHook(() => useDocReady(doc));
    expect(result.current).toBe(false);
  });

  it("no timeout by default", async () => {
    vi.useFakeTimers();
    const doc = mockDoc(new Promise(() => {}));
    const { result } = renderHook(() => useDocReady(doc));

    // Advance well past any reasonable timeout.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it("resolves on timeout if provided", async () => {
    vi.useFakeTimers();
    const doc = mockDoc(new Promise(() => {}));
    const { result } = renderHook(() => useDocReady(doc, 5000));

    expect(result.current).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(true);
    vi.useRealTimers();
  });

  it("ready before timeout uses ready", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const doc = mockDoc(promise);
    const { result } = renderHook(() => useDocReady(doc, 60_000));

    expect(result.current).toBe(false);

    await act(async () => {
      resolve();
    });
    expect(result.current).toBe(true);
    vi.useRealTimers();
  });

  it("no state update after unmount", async () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const doc = mockDoc(promise);
    const { unmount } = renderHook(() => useDocReady(doc));

    unmount();
    // Should not warn or throw.
    await act(async () => {
      resolve();
    });
  });

  it("resets on doc change", async () => {
    const doc1 = mockDoc(Promise.resolve());
    const doc2 = mockDoc(new Promise(() => {}));
    const { result, rerender } = renderHook(({ doc }) => useDocReady(doc), {
      initialProps: { doc: doc1 },
    });

    await act(async () => {});
    expect(result.current).toBe(true);

    rerender({ doc: doc2 });
    // New doc hasn't resolved yet.
    expect(result.current).toBe(false);
  });
});
