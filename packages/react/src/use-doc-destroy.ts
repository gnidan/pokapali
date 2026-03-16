import { useEffect } from "react";
import type { Doc } from "@pokapali/core";

/**
 * Destroy a Doc on unmount. Call this hook LAST in
 * your component so React cleans it up first (reverse
 * declaration order), keeping the doc alive for all
 * other effect cleanups.
 */
export function useDocDestroy(doc: Doc): void {
  useEffect(() => {
    return () => {
      doc.destroy();
    };
  }, [doc]);
}
