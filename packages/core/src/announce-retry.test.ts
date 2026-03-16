/**
 * Tests for announce retry behavior when no mesh
 * peers are available (GH #225).
 *
 * Exercises the retry pattern used in create-doc.ts
 * effects.announce handler. Since that handler is a
 * closure inside createDoc(), we test the logic
 * pattern directly here with fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mirrors the retry logic from create-doc.ts
// effects.announce handler.
const ANNOUNCE_RETRY_MAX = 14;
const ANNOUNCE_RETRY_MS = 1_000;

interface RetryState {
  pendingRetry: ReturnType<typeof setTimeout> | null;
}

/**
 * Simulate the announce-with-retry pattern from
 * create-doc.ts. This is a direct extraction of the
 * retry scheduling logic for testability.
 */
function announceWithRetry(
  doAnnounce: () => void,
  hasMesh: () => boolean,
  signal: AbortSignal,
  state: RetryState,
): void {
  // Cancel any pending retry (superseded)
  if (state.pendingRetry !== null) {
    clearTimeout(state.pendingRetry);
    state.pendingRetry = null;
  }

  // Always attempt immediately
  doAnnounce();

  if (!hasMesh()) {
    let retries = 0;
    const scheduleRetry = () => {
      if (signal.aborted) return;
      if (retries >= ANNOUNCE_RETRY_MAX) return;
      retries++;
      state.pendingRetry = setTimeout(() => {
        state.pendingRetry = null;
        if (signal.aborted) return;
        if (hasMesh()) {
          doAnnounce();
        } else {
          scheduleRetry();
        }
      }, ANNOUNCE_RETRY_MS);
    };
    scheduleRetry();
  }
}

describe("announce retry (GH #225)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces immediately even with no mesh", () => {
    const announce = vi.fn();
    const ac = new AbortController();
    const state: RetryState = { pendingRetry: null };

    announceWithRetry(announce, () => false, ac.signal, state);

    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("does not schedule retry when mesh exists", () => {
    const announce = vi.fn();
    const ac = new AbortController();
    const state: RetryState = { pendingRetry: null };

    announceWithRetry(announce, () => true, ac.signal, state);

    expect(announce).toHaveBeenCalledTimes(1);
    expect(state.pendingRetry).toBeNull();

    // Advance past retry window
    vi.advanceTimersByTime(15_000);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("retries until mesh appears," + " then re-announces", () => {
    const announce = vi.fn();
    const ac = new AbortController();
    const state: RetryState = { pendingRetry: null };
    let meshAvailable = false;

    announceWithRetry(announce, () => meshAvailable, ac.signal, state);

    // Initial call
    expect(announce).toHaveBeenCalledTimes(1);

    // Advance 2 retries with no mesh
    vi.advanceTimersByTime(2_000);
    expect(announce).toHaveBeenCalledTimes(1);

    // Mesh appears
    meshAvailable = true;
    vi.advanceTimersByTime(1_000);
    expect(announce).toHaveBeenCalledTimes(2);

    // No more retries after success
    vi.advanceTimersByTime(10_000);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("caps retries at ANNOUNCE_RETRY_MAX", () => {
    const announce = vi.fn();
    const ac = new AbortController();
    const state: RetryState = { pendingRetry: null };

    announceWithRetry(announce, () => false, ac.signal, state);

    expect(announce).toHaveBeenCalledTimes(1);

    // Advance past all retries
    vi.advanceTimersByTime(ANNOUNCE_RETRY_MAX * ANNOUNCE_RETRY_MS + 1_000);

    // Only the initial call — retries checked mesh
    // but never found peers, so never re-announced
    expect(announce).toHaveBeenCalledTimes(1);
    expect(state.pendingRetry).toBeNull();
  });

  it("stops retrying on abort", () => {
    const announce = vi.fn();
    const ac = new AbortController();
    const state: RetryState = { pendingRetry: null };

    announceWithRetry(announce, () => false, ac.signal, state);

    expect(announce).toHaveBeenCalledTimes(1);

    // Advance 2 retries
    vi.advanceTimersByTime(2_000);

    // Abort
    ac.abort();

    // Advance more — no new retries
    vi.advanceTimersByTime(15_000);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("cancels pending retry when new announce" + " supersedes", () => {
    const announce1 = vi.fn();
    const announce2 = vi.fn();
    const ac = new AbortController();
    const state: RetryState = { pendingRetry: null };

    // First announce with no mesh
    announceWithRetry(announce1, () => false, ac.signal, state);
    expect(state.pendingRetry).not.toBeNull();

    // Supersede with second announce (mesh exists)
    announceWithRetry(announce2, () => true, ac.signal, state);

    // First retry timer was cancelled
    expect(state.pendingRetry).toBeNull();

    // Advance — first announce's retry should NOT
    // fire
    vi.advanceTimersByTime(15_000);
    expect(announce1).toHaveBeenCalledTimes(1);
    expect(announce2).toHaveBeenCalledTimes(1);
  });
});
