import { describe, it, expect, vi, afterEach } from "vitest";
import { createIpnsThrottle } from "./ipns-throttle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createIpnsThrottle", () => {
  it("allows bursts up to rate limit", () => {
    const throttle = createIpnsThrottle(5);
    // Should allow 5 immediate acquires (bucket
    // starts full)
    for (let i = 0; i < 5; i++) {
      expect(throttle.tryAcquire()).toBe(true);
    }
    // 6th should fail — bucket empty
    expect(throttle.tryAcquire()).toBe(false);
  });

  it("refills tokens over time", () => {
    vi.useFakeTimers();
    const throttle = createIpnsThrottle(10);

    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      throttle.tryAcquire();
    }
    expect(throttle.tryAcquire()).toBe(false);

    // Advance 500ms — should have ~5 tokens
    vi.advanceTimersByTime(500);
    let acquired = 0;
    while (throttle.tryAcquire()) acquired++;
    expect(acquired).toBeGreaterThanOrEqual(4);
    expect(acquired).toBeLessThanOrEqual(6);
  });

  it("caps tokens at bucket size", () => {
    vi.useFakeTimers();
    const throttle = createIpnsThrottle(5);

    // Wait a long time — tokens should cap at 5
    vi.advanceTimersByTime(10_000);
    let acquired = 0;
    while (throttle.tryAcquire()) acquired++;
    expect(acquired).toBe(5);
  });

  it("acquire waits for token when empty", async () => {
    vi.useFakeTimers();
    const throttle = createIpnsThrottle(10);

    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      throttle.tryAcquire();
    }

    // acquire should wait ~100ms for 1 token at
    // 10/sec rate
    let resolved = false;
    const p = throttle.acquire().then(() => {
      resolved = true;
    });

    // Not resolved yet
    expect(resolved).toBe(false);

    // Advance 100ms — enough for 1 token
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(resolved).toBe(true);
  });

  it("acquire rejects when signal aborted", async () => {
    vi.useFakeTimers();
    const throttle = createIpnsThrottle(10);

    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      throttle.tryAcquire();
    }

    const ctrl = new AbortController();
    const p = throttle.acquire(ctrl.signal);

    // Abort before token refills
    ctrl.abort();

    await expect(p).rejects.toThrow();
  });

  it("acquire succeeds immediately with tokens", async () => {
    const throttle = createIpnsThrottle(10);
    // Should resolve immediately — bucket has tokens
    await throttle.acquire();
    // No timeout = pass
  });

  it("serializes concurrent acquire() callers", async () => {
    vi.useFakeTimers();
    // Rate: 2/sec. Drain bucket, then 5 concurrent
    // acquire() calls. They should resolve one at a
    // time (~500ms apart), NOT all at once.
    const throttle = createIpnsThrottle(2);

    // Drain bucket
    throttle.tryAcquire();
    throttle.tryAcquire();

    const resolved: number[] = [];
    const promises = Array.from({ length: 5 }, (_, i) =>
      throttle.acquire().then(() => {
        resolved.push(Date.now());
      }),
    );

    // After 500ms, exactly 1 should have resolved
    // (1 token refilled at 2/sec)
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toHaveLength(1);

    // After another 500ms, 2 total
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toHaveLength(2);

    // After 1500ms more (3s total from drain), all 5
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all(promises);
    expect(resolved).toHaveLength(5);
  });

  it("tracks metrics", () => {
    const throttle = createIpnsThrottle(5);

    throttle.tryAcquire(); // success
    throttle.tryAcquire(); // success
    throttle.tryAcquire(); // success
    throttle.tryAcquire(); // success
    throttle.tryAcquire(); // success
    throttle.tryAcquire(); // fail — empty

    const m = throttle.metrics();
    expect(m.acquired).toBe(5);
    expect(m.rejected).toBe(1);
  });
});
