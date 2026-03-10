import type { CollabDoc } from "./index.js";
export interface AutoSaveOptions {
    debounceMs?: number;
}
/**
 * Set up auto-save for a CollabDoc:
 * - Debounced pushSnapshot on snapshot-recommended
 * - beforeunload prompt if unpushed changes
 * - pushSnapshot on visibilitychange (hidden)
 *
 * Only activates if doc.capability.canPushSnapshots.
 * Returns a cleanup function.
 */
export declare function createAutoSaver(doc: CollabDoc, options?: AutoSaveOptions): () => void;
//# sourceMappingURL=auto-save.d.ts.map