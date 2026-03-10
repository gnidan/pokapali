const DEFAULT_DEBOUNCE_MS = 5_000;
/**
 * Set up auto-save for a CollabDoc:
 * - Debounced pushSnapshot on snapshot-recommended
 * - beforeunload prompt if unpushed changes
 * - pushSnapshot on visibilitychange (hidden)
 *
 * Only activates if doc.capability.canPushSnapshots.
 * Returns a cleanup function.
 */
export function createAutoSaver(doc, options) {
    if (!doc.capability.canPushSnapshots) {
        return () => { };
    }
    const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    let timer = null;
    function doSave() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        doc.pushSnapshot().catch(() => { });
    }
    function onSnapshotRecommended() {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(doSave, debounceMs);
    }
    function onBeforeUnload(e) {
        if (doc.saveState === "dirty") {
            e.preventDefault();
        }
    }
    function onVisibilityChange() {
        if (document.visibilityState === "hidden" &&
            doc.saveState === "dirty") {
            doSave();
        }
    }
    doc.on("snapshot-recommended", onSnapshotRecommended);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        doc.off("snapshot-recommended", onSnapshotRecommended);
        window.removeEventListener("beforeunload", onBeforeUnload);
        document.removeEventListener("visibilitychange", onVisibilityChange);
    };
}
//# sourceMappingURL=auto-save.js.map