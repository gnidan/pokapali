/**
 * Global rate limiter for new IPNS name admissions.
 * Prevents abuse where a malicious client floods the
 * pinner with new names, exhausting capacity.
 *
 * Sliding window: tracks admission timestamps for the
 * last hour and rejects when the count exceeds the
 * configured limit.
 */

const WINDOW_MS = 3_600_000; // 1 hour

export const DEFAULT_MAX_NEW_NAMES_PER_HOUR = 100;

export interface NewNameLimiter {
  /** Returns true if a new name can be admitted. */
  tryAdmit(now?: number): boolean;
  /** Current limiter statistics. */
  metrics(): { admitted: number; rejected: number };
}

export function createNewNameLimiter(maxPerHour: number): NewNameLimiter {
  const timestamps: number[] = [];
  let admitted = 0;
  let rejected = 0;

  function prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
  }

  return {
    tryAdmit(now: number = Date.now()): boolean {
      prune(now);
      if (timestamps.length >= maxPerHour) {
        rejected++;
        return false;
      }
      timestamps.push(now);
      admitted++;
      return true;
    },

    metrics() {
      return { admitted, rejected };
    },
  };
}
