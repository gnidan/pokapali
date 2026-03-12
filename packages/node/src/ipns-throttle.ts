/**
 * Token bucket rate limiter for IPNS operations.
 * Caps outbound requests to delegated-ipfs.dev to
 * avoid being rate-limited or banned at scale.
 *
 * GossipSub is the primary notification path; IPNS
 * is best-effort. When the bucket is empty, callers
 * can either wait (acquire) or skip (tryAcquire).
 */

export interface IpnsThrottle {
  /** Non-blocking: returns true if a token was
   * available, false otherwise. */
  tryAcquire(): boolean;

  /** Blocking: waits for a token. Rejects if the
   * signal is aborted before a token is available. */
  acquire(signal?: AbortSignal): Promise<void>;

  /** Current throttle statistics. */
  metrics(): { acquired: number; rejected: number };
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
}

export function createIpnsThrottle(ratePerSec: number): IpnsThrottle {
  let tokens = ratePerSec;
  let lastRefill = Date.now();
  let acquired = 0;
  let rejected = 0;
  const waiters: Waiter[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(ratePerSec, tokens + elapsed * ratePerSec);
    lastRefill = now;
  }

  function drainWaiters(): void {
    refill();
    while (tokens >= 1 && waiters.length > 0) {
      tokens -= 1;
      acquired++;
      const w = waiters.shift()!;
      w.cleanup?.();
      w.resolve();
    }
    // Schedule next drain if waiters remain
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (waiters.length > 0) {
      const waitMs = ((1 - tokens) / ratePerSec) * 1000;
      drainTimer = setTimeout(drainWaiters, waitMs);
    }
  }

  function tryAcquire(): boolean {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      acquired++;
      return true;
    }
    rejected++;
    return false;
  }

  async function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }

    refill();
    if (tokens >= 1) {
      tokens -= 1;
      acquired++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };

      if (signal) {
        function onAbort() {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          rejected++;
          reject(signal!.reason ?? new Error("aborted"));
        }
        signal.addEventListener("abort", onAbort, {
          once: true,
        });
        waiter.cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      waiters.push(waiter);

      // Schedule drain if this is the first waiter
      if (waiters.length === 1 && drainTimer === null) {
        const waitMs = ((1 - tokens) / ratePerSec) * 1000;
        drainTimer = setTimeout(drainWaiters, waitMs);
      }
    });
  }

  return {
    tryAcquire,
    acquire,
    metrics() {
      return { acquired, rejected };
    },
  };
}
