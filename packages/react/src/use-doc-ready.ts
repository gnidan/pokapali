import { useEffect, useState } from "react";
import type { Doc } from "@pokapali/core";

/**
 * Returns true once doc.ready() resolves.
 *
 * If timeoutMs is provided, also resolves to true
 * after that many milliseconds (whichever comes
 * first). No default timeout — the app decides.
 */
export function useDocReady(doc: Doc, timeoutMs?: number): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);

    doc.ready().then(() => {
      if (!cancelled) setReady(true);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (!cancelled) setReady(true);
      }, timeoutMs);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [doc, timeoutMs]);

  return ready;
}
