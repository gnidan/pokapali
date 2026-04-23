import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSnapshotFlash } from "./use-snapshot-flash.js";
import type { Doc, SnapshotEvent, Feed } from "@pokapali/core";

function mockDoc(): {
  doc: Doc;
  emit: (event: SnapshotEvent) => void;
} {
  let subscriber: (() => void) | null = null;
  let snapshot: SnapshotEvent | null = null;

  const snapshotEvents: Feed<SnapshotEvent | null> = {
    subscribe(cb: () => void) {
      subscriber = cb;
      return () => {
        subscriber = null;
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };

  const doc = { snapshotEvents } as unknown as Doc;

  return {
    doc,
    emit(event: SnapshotEvent) {
      snapshot = event;
      subscriber?.();
    },
  };
}

function fakeEvent(overrides?: Partial<SnapshotEvent>): SnapshotEvent {
  return {
    cid: {} as SnapshotEvent["cid"],
    seq: 1,
    ts: Date.now(),
    isLocal: false,
    ...overrides,
  };
}

describe("useSnapshotFlash", () => {
  it("starts false", () => {
    const { doc } = mockDoc();
    const { result } = renderHook(() => useSnapshotFlash(doc));
    expect(result.current).toBe(false);
  });

  it("flashes true on snapshot event", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() => useSnapshotFlash(doc));

    act(() => emit(fakeEvent()));
    expect(result.current).toBe(true);
    vi.useRealTimers();
  });

  it("resets after duration", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() => useSnapshotFlash(doc, 500));

    act(() => emit(fakeEvent()));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it("extends flash on repeated events", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() => useSnapshotFlash(doc, 500));

    act(() => emit(fakeEvent()));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(true);

    // Second event resets the timer
    act(() => emit(fakeEvent()));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it("cleans up on unmount", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { unmount } = renderHook(() => useSnapshotFlash(doc, 500));

    act(() => emit(fakeEvent()));
    unmount();
    // Should not throw
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
  });

  it("accepts options object for durationMs", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() =>
      useSnapshotFlash(doc, { durationMs: 300 }),
    );

    act(() => emit(fakeEvent()));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it("flashes on remote events by default", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() => useSnapshotFlash(doc));

    act(() => emit(fakeEvent({ isLocal: false })));
    expect(result.current).toBe(true);
    vi.useRealTimers();
  });

  it("ignores remote events when localOnly", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() =>
      useSnapshotFlash(doc, { localOnly: true }),
    );

    act(() => emit(fakeEvent({ isLocal: false })));
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it("flashes on local events when localOnly", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() =>
      useSnapshotFlash(doc, { localOnly: true }),
    );

    act(() => emit(fakeEvent({ isLocal: true })));
    expect(result.current).toBe(true);
    vi.useRealTimers();
  });

  it("flashes on all events when localOnly is false", () => {
    vi.useFakeTimers();
    const { doc, emit } = mockDoc();
    const { result } = renderHook(() =>
      useSnapshotFlash(doc, { localOnly: false }),
    );

    act(() => emit(fakeEvent({ isLocal: false })));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(false);

    act(() => emit(fakeEvent({ isLocal: true })));
    expect(result.current).toBe(true);
    vi.useRealTimers();
  });
});
