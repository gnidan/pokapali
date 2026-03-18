/**
 * async-utils.ts — Generic async iteration utilities:
 * createAsyncQueue, merge, scan.
 *
 * No domain dependencies — pure async plumbing.
 */

// ── createAsyncQueue ─────────────────────────────

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
}

/**
 * Bridge push-based callbacks to pull-based async
 * iteration. Values pushed before consumption are
 * buffered. Terminates when signal aborts (after
 * draining any buffered values).
 */
export function createAsyncQueue<T>(signal: AbortSignal): AsyncQueue<T> {
  const buffer: T[] = [];
  let resolve: (() => void) | null = null;
  let done = signal.aborted;

  signal.addEventListener(
    "abort",
    () => {
      done = true;
      if (resolve) resolve();
    },
    { once: true },
  );

  async function* iterate(): AsyncGenerator<T> {
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
      if (done) return;
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }
  }

  const gen = iterate();

  return {
    push(value: T) {
      if (done) return;
      buffer.push(value);
      if (resolve) resolve();
    },
    [Symbol.asyncIterator]() {
      return gen;
    },
  };
}

// ── merge ────────────────────────────────────────

/**
 * Interleave multiple async iterables into a single
 * stream via Promise.race. No buffering — natural
 * backpressure from `for await`.
 */
export async function* merge<T>(
  ...sources: AsyncIterable<T>[]
): AsyncGenerator<T> {
  const iters = sources.map((s) => s[Symbol.asyncIterator]());
  const pending = new Map<
    number,
    Promise<{
      idx: number;
      result: IteratorResult<T>;
    }>
  >();

  for (let i = 0; i < iters.length; i++) {
    pending.set(
      i,
      iters[i]!.next().then((result) => ({ idx: i, result })),
    );
  }

  while (pending.size > 0) {
    const { idx, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(idx);
    } else {
      yield result.value;
      pending.set(
        idx,
        iters[idx]!.next().then((result) => ({ idx, result })),
      );
    }
  }
}

// ── scan ─────────────────────────────────────────

/**
 * Encapsulated fold over an async iterable. Yields
 * `{ prev, next, fact }` after each reduction step.
 * The accumulator `let` lives inside the generator
 * closure — mutation is invisible outside.
 */
export async function* scan<S, F>(
  facts: AsyncIterable<F>,
  reducer: (s: S, f: F) => S,
  init: S,
): AsyncGenerator<{ prev: S; next: S; fact: F }> {
  let s = init;
  for await (const fact of facts) {
    const prev = s;
    s = reducer(s, fact);
    yield { prev, next: s, fact };
  }
}
