import { useEffect, useRef, useState } from "react";
import type { Doc } from "@pokapali/core";

/**
 * Returns true briefly after a snapshot event fires,
 * enabling visual feedback (flash/pulse). Resets to
 * false after durationMs (default 2000).
 */
export function useSnapshotFlash(doc: Doc, durationMs = 2000): boolean {
  const [flashing, setFlashing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const unsub = doc.snapshotEvents.subscribe(() => {
      const event = doc.snapshotEvents.getSnapshot();
      if (!event) return;

      setFlashing(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlashing(false), durationMs);
    });

    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [doc, durationMs]);

  return flashing;
}
