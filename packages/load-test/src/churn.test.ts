import { describe, test, expect, vi } from "vitest";
import type { LoadTestEvent } from "./metrics.js";
import {
  startChurnScheduler,
  type ChurnConfig,
  type ChurnCallbacks,
} from "./churn.js";

function makeCallbacks(overrides?: Partial<ChurnCallbacks>) {
  let writerId = 0;
  let readerId = 0;
  const events: LoadTestEvent[] = [];

  const callbacks: ChurnCallbacks = {
    addWriter: overrides?.addWriter ?? vi.fn(async () => `w-${++writerId}`),
    removeWriter: overrides?.removeWriter ?? vi.fn(async () => {}),
    addReader: overrides?.addReader ?? vi.fn(async () => `r-${++readerId}`),
    removeReader: overrides?.removeReader ?? vi.fn(async () => {}),
    onEvent: overrides?.onEvent ?? vi.fn((e: LoadTestEvent) => events.push(e)),
  };

  return { callbacks, events };
}

describe("ChurnScheduler", () => {
  test("records node-joined and node-left events", async () => {
    vi.useFakeTimers();

    const { callbacks, events } = makeCallbacks();
    const config: ChurnConfig = {
      baselineWriters: 1,
      baselineReaders: 1,
      churnIntervalMs: 200,
      churnSize: 1,
      stabilizeMs: 50,
    };

    const scheduler = await startChurnScheduler(config, callbacks);

    // Baseline spawn should emit node-joined
    const joinedEvents = events.filter((e) => e.type === "node-joined");
    expect(joinedEvents.length).toBe(2); // 1 writer + 1 reader

    // Trigger a churn cycle
    await vi.advanceTimersByTimeAsync(200);
    // After removal, wait for stabilize
    await vi.advanceTimersByTimeAsync(50);

    const leftEvents = events.filter((e) => e.type === "node-left");
    expect(leftEvents.length).toBeGreaterThanOrEqual(1);

    scheduler.stop();
    vi.useRealTimers();
  });

  test("spawns baseline writers and readers", async () => {
    vi.useFakeTimers();

    const { callbacks } = makeCallbacks();
    const config: ChurnConfig = {
      baselineWriters: 3,
      baselineReaders: 2,
      churnIntervalMs: 10_000,
      churnSize: 1,
      stabilizeMs: 100,
    };

    const scheduler = await startChurnScheduler(config, callbacks);

    expect(scheduler.writers.size).toBe(3);
    expect(scheduler.readers.size).toBe(2);
    expect(callbacks.addWriter).toHaveBeenCalledTimes(3);
    expect(callbacks.addReader).toHaveBeenCalledTimes(2);

    scheduler.stop();
    vi.useRealTimers();
  });

  test("executes a churn cycle with events", async () => {
    vi.useFakeTimers();

    const { callbacks, events } = makeCallbacks();
    const config: ChurnConfig = {
      baselineWriters: 2,
      baselineReaders: 2,
      churnIntervalMs: 100,
      churnSize: 1,
      stabilizeMs: 10,
    };

    const scheduler = await startChurnScheduler(config, callbacks);

    // Clear baseline events
    events.length = 0;

    // Trigger churn cycle
    await vi.advanceTimersByTimeAsync(100);
    // Wait for stabilize delay
    await vi.advanceTimersByTimeAsync(10);

    expect(scheduler.cycleCount).toBe(1);

    const cycleEvents = events.filter((e) => e.type === "churn-cycle");
    expect(cycleEvents.length).toBe(1);

    const removed = events.filter((e) => e.type === "node-left");
    expect(removed.length).toBe(1);

    const added = events.filter((e) => e.type === "node-joined");
    expect(added.length).toBe(1);

    scheduler.stop();
    vi.useRealTimers();
  });

  test("stop() prevents further churn cycles", async () => {
    vi.useFakeTimers();

    const { callbacks, events } = makeCallbacks();
    const config: ChurnConfig = {
      baselineWriters: 2,
      baselineReaders: 2,
      churnIntervalMs: 100,
      churnSize: 1,
      stabilizeMs: 10,
    };

    const scheduler = await startChurnScheduler(config, callbacks);

    events.length = 0;
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(500);

    const cycleEvents = events.filter((e) => e.type === "churn-cycle");
    expect(cycleEvents.length).toBe(0);
    expect(scheduler.cycleCount).toBe(0);

    vi.useRealTimers();
  });

  test("keeps at least 1 writer alive", async () => {
    vi.useFakeTimers();

    const { callbacks, events } = makeCallbacks();
    const config: ChurnConfig = {
      baselineWriters: 1,
      baselineReaders: 0,
      churnIntervalMs: 50,
      churnSize: 1,
      stabilizeMs: 10,
    };

    const scheduler = await startChurnScheduler(config, callbacks);

    expect(scheduler.writers.size).toBe(1);

    events.length = 0;

    // Trigger churn cycle
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(10);

    // Writer should not have been removed
    expect(scheduler.writers.size).toBe(1);
    const leftEvents = events.filter((e) => e.type === "node-left");
    expect(leftEvents.length).toBe(0);

    scheduler.stop();
    vi.useRealTimers();
  });
});
