/**
 * Visibility-aware interval that pauses or slows
 * when the browser tab is hidden.
 *
 * Duplicated from @pokapali/core — the sync package
 * cannot depend on core without creating a cycle.
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

export function createThrottledInterval(
  callback: () => void,
  activeMs: number,
  options?: ThrottledIntervalOptions,
): ThrottledInterval {
  const backgroundMs = options?.backgroundMs ?? 0;
  const fireOnResume = options?.fireOnResume ?? true;

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
      if (fireOnResume) callback();
      start(activeMs);
    }
  }

  if (document.visibilityState === "hidden" && backgroundMs > 0) {
    start(backgroundMs);
  } else if (document.visibilityState !== "hidden") {
    start(activeMs);
  }

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
