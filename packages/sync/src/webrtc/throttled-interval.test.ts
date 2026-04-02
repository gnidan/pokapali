import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createThrottledInterval } from "./throttled-interval.js";

// Mock document.visibilityState and events.
let visibilityState = "visible";
const listeners: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = "visible";
  listeners.length = 0;

  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(_type: string, fn: () => void) {
      listeners.push(fn);
    },
    removeEventListener(_type: string, fn: () => void) {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hide() {
  visibilityState = "hidden";
  for (const fn of [...listeners]) fn();
}

function show() {
  visibilityState = "visible";
  for (const fn of [...listeners]) fn();
}

describe("createThrottledInterval", () => {
  it("fires callback at active interval", () => {
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000);
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(3);
    t.destroy();
  });

  it("pauses when hidden (backgroundMs=0)", () => {
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000, {
      backgroundMs: 0,
    });
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(2);

    hide();
    vi.advanceTimersByTime(5000);
    // No additional calls while hidden.
    expect(cb).toHaveBeenCalledTimes(2);

    t.destroy();
  });

  it("slows when hidden (backgroundMs > 0)", () => {
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000, {
      backgroundMs: 5000,
    });
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(2);

    hide();
    vi.advanceTimersByTime(5000);
    // One call at the background interval.
    expect(cb).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(4);

    t.destroy();
  });

  it("fires immediately on resume by default", () => {
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000, {
      backgroundMs: 0,
    });
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);

    hide();
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1);

    show();
    // Immediate fire on resume.
    expect(cb).toHaveBeenCalledTimes(2);

    // Active interval resumes.
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(3);

    t.destroy();
  });

  it("skips resume fire when fireOnResume=false", () => {
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000, {
      backgroundMs: 0,
      fireOnResume: false,
    });
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);

    hide();
    show();
    // No immediate fire.
    expect(cb).toHaveBeenCalledTimes(1);

    // But active interval still resumes.
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(2);

    t.destroy();
  });

  it("cleans up on destroy", () => {
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000);
    t.destroy();
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
    // Listener removed.
    expect(listeners).toHaveLength(0);
  });

  it("does not start when hidden and backgroundMs=0", () => {
    visibilityState = "hidden";
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000, {
      backgroundMs: 0,
    });
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();

    show();
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(2);

    t.destroy();
  });

  it("starts at background rate when hidden " + "and backgroundMs > 0", () => {
    visibilityState = "hidden";
    const cb = vi.fn();
    const t = createThrottledInterval(cb, 1000, {
      backgroundMs: 3000,
    });
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(2);

    t.destroy();
  });
});
