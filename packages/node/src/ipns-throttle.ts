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

export function createIpnsThrottle(ratePerSec: number): IpnsThrottle {
  let tokens = ratePerSec;
  let lastRefill = Date.now();
  let acquired = 0;
  let rejected = 0;

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(ratePerSec, tokens + elapsed * ratePerSec);
    lastRefill = now;
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

    // Wait for next token
    const waitMs = ((1 - tokens) / ratePerSec) * 1000;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        tokens = 0;
        lastRefill = Date.now();
        acquired++;
        resolve();
      }, waitMs);

      function onAbort() {
        clearTimeout(timer);
        rejected++;
        reject(signal!.reason ?? new Error("aborted"));
      }

      signal?.addEventListener("abort", onAbort, {
        once: true,
      });
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
