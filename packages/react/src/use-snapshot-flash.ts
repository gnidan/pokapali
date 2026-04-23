import { useEffect, useRef, useState } from "react";
import type { Doc } from "@pokapali/core";

export interface SnapshotFlashOptions {
  /** Flash duration in ms (default 2000). */
  durationMs?: number;
  /**
   * When true, only flash for locally-created
   * snapshots. Peer-received snapshots (isLocal
   * === false) are ignored.
   *
   * Default: false (flash on all snapshots).
   */
  localOnly?: boolean;
}

/**
 * Returns true briefly after a snapshot event fires,
 * enabling visual feedback (flash/pulse). Resets to
 * false after durationMs (default 2000).
 *
 * Since S54, `snapshotEvents` fires for both local
 * and peer-received snapshots. Use `localOnly: true`
 * to restore pre-S54 behavior (flash only on local
 * publish).
 */
export function useSnapshotFlash(
  doc: Doc,
  options?: number | SnapshotFlashOptions,
): boolean {
  const durationMs =
    typeof options === "number" ? options : (options?.durationMs ?? 2000);
  const localOnly =
    typeof options === "number" ? false : (options?.localOnly ?? false);

  const [flashing, setFlashing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const unsub = doc.snapshotEvents.subscribe(() => {
      const event = doc.snapshotEvents.getSnapshot();
      if (!event) return;
      if (localOnly && !event.isLocal) return;

      setFlashing(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlashing(false), durationMs);
    });

    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [doc, durationMs, localOnly]);

  return flashing;
}
