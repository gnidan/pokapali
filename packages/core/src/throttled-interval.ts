/**
 * throttled-interval.ts — Visibility-aware interval
 * that pauses or slows when the browser tab is hidden.
 *
 * Wraps setInterval with Page Visibility API support
 * to reduce CPU, network, and battery usage in
 * background tabs.
 */

export interface ThrottledInterval {
  destroy(): void;
}

export interface ThrottledIntervalOptions {
  /** Interval (ms) when tab is hidden. 0 = pause. */
  backgroundMs?: number;
  /** Fire callback immediately when tab becomes
   *  visible again. Default: true. */
  fireOnResume?: boolean;
}

/**
 * Create a setInterval that respects the Page
 * Visibility API. When the tab is hidden, the
 * interval is either paused (backgroundMs=0) or
 * slowed (backgroundMs>0). On resume, an immediate
 * callback fires (unless fireOnResume is false) and
 * the active interval restarts.
 *
 * Falls back to a plain setInterval when
 * `document` is not available (SSR / Node).
 */
export function createThrottledInterval(
  callback: () => void,
  activeMs: number,
  options?: ThrottledIntervalOptions,
): ThrottledInterval {
  const backgroundMs = options?.backgroundMs ?? 0;
  const fireOnResume = options?.fireOnResume ?? true;

  // Node / SSR fallback — no visibility API.
  if (
    typeof document === "undefined" ||
    typeof document.addEventListener !== "function"
  ) {
    const id = setInterval(callback, activeMs);
    return { destroy: () => clearInterval(id) };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  function start(ms: number) {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(callback, ms);
  }

  function onVisibilityChange() {
    if (destroyed) return;
    if (document.visibilityState === "hidden") {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (backgroundMs > 0) {
        start(backgroundMs);
      }
    } else {
      // Visible again
      if (fireOnResume) callback();
      start(activeMs);
    }
  }

  // Initial start — respect current visibility.
  if (document.visibilityState === "hidden" && backgroundMs > 0) {
    start(backgroundMs);
  } else if (document.visibilityState !== "hidden") {
    start(activeMs);
  }
  // If hidden and backgroundMs=0, don't start at all.

  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    destroy() {
      destroyed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
