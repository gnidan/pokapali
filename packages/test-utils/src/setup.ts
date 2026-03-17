/**
 * Vitest setup — polyfill Promise.withResolvers for
 * Node <22. Required because libp2p → mortice →
 * it-queue uses this ES2024 feature at import time.
 *
 * Safe to remove once minimum Node is 22+.
 */

if (typeof Promise.withResolvers !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
