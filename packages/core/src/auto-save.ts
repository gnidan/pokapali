import type { Doc } from "./index.js";

const DEFAULT_DEBOUNCE_MS = 5_000;

export interface AutoSaveOptions {
  debounceMs?: number;
}

/**
 * Set up auto-save for a Doc:
 * - Debounced publish on publish-needed
 * - beforeunload prompt if unpushed changes
 * - publish on visibilitychange (hidden)
 *
 * Only activates if doc.capability.canPushSnapshots.
 * Returns a cleanup function.
 */
export function createAutoSaver(
  doc: Doc,
  options?: AutoSaveOptions,
): () => void {
  if (!doc.capability.canPushSnapshots) {
    return () => {};
  }

  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function doSave() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (doc.saveState.getSnapshot() !== "dirty") return;
    doc.publish().catch(() => {});
  }

  function onSnapshotRecommended() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(doSave, debounceMs);
  }

  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (doc.saveState.getSnapshot() === "dirty") {
      e.preventDefault();
    }
  }

  function onVisibilityChange() {
    if (
      document.visibilityState === "hidden" &&
      doc.saveState.getSnapshot() === "dirty"
    ) {
      doSave();
    }
  }

  doc.on("publish-needed", onSnapshotRecommended);
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    doc.off("publish-needed", onSnapshotRecommended);
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
