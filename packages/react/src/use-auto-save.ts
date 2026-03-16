import { useEffect } from "react";
import type { Doc } from "@pokapali/core";
import { createAutoSaver } from "@pokapali/core";

/**
 * Set up auto-save for a Doc. Wraps createAutoSaver
 * in a useEffect with cleanup.
 *
 * No-op if the doc lacks push capability.
 */
export function useAutoSave(doc: Doc, debounceMs?: number): void {
  useEffect(() => {
    return createAutoSaver(
      doc,
      debounceMs !== undefined ? { debounceMs } : undefined,
    );
  }, [doc, debounceMs]);
}
