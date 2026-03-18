/**
 * Property tests for async-utils.ts — merge, scan,
 * createAsyncQueue.
 *
 * Verifies structural invariants that hold for ALL
 * inputs, not just hand-picked examples.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { merge, scan, createAsyncQueue } from "./async-utils.js";

// ── Helpers ─────────────────────────────────────

async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

// ── merge ───────────────────────────────────────

describe("merge (property)", () => {
  it("preserves total item count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.integer(), { maxLength: 20 }), {
          maxLength: 5,
        }),
        async (arrays) => {
          const sources = arrays.map((a) => asyncFrom(a));
          const merged = await collect(merge(...sources));
          const total = arrays.reduce((s, a) => s + a.length, 0);
          expect(merged).toHaveLength(total);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("output contains exactly the input items", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.integer(), { maxLength: 20 }), {
          maxLength: 5,
        }),
        async (arrays) => {
          const sources = arrays.map((a) => asyncFrom(a));
          const merged = await collect(merge(...sources));
          const expected = arrays.flat().sort((a, b) => a - b);
          const actual = merged.slice().sort((a, b) => a - b);
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("preserves relative order within each source", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.integer({ min: 0, max: 999 }), { maxLength: 15 }),
          { minLength: 1, maxLength: 4 },
        ),
        async (arrays) => {
          // Tag each item with its source index
          type Tagged = { src: number; val: number; idx: number };
          const taggedArrays: Tagged[][] = arrays.map((arr, src) =>
            arr.map((val, idx) => ({ src, val, idx })),
          );

          const sources = taggedArrays.map((a) => asyncFrom(a));
          const merged = await collect(merge(...sources));

          // For each source, extract items in merged order
          // and verify they appear in original order
          for (let s = 0; s < arrays.length; s++) {
            const fromSource = merged
              .filter((t) => t.src === s)
              .map((t) => t.idx);
            for (let i = 1; i < fromSource.length; i++) {
              expect(fromSource[i]!).toBeGreaterThan(fromSource[i - 1]!);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("single source yields items unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 30 }),
        async (items) => {
          const result = await collect(merge(asyncFrom(items)));
          expect(result).toEqual(items);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("zero sources yields empty", async () => {
    const result = await collect(merge());
    expect(result).toEqual([]);
  });
});

// ── scan ────────────────────────────────────────

describe("scan (property)", () => {
  it("output length equals input length", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { maxLength: 50 }),
        async (items) => {
          const results = await collect(
            scan(asyncFrom(items), (s, f) => s + f, 0),
          );
          expect(results).toHaveLength(items.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("first prev equals init", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer(),
        fc.array(fc.integer(), { minLength: 1, maxLength: 30 }),
        async (init, items) => {
          const results = await collect(
            scan(asyncFrom(items), (s, f) => s + f, init),
          );
          expect(results[0]!.prev).toBe(init);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("prev/next chain is consistent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 2, maxLength: 30 }),
        async (items) => {
          const results = await collect(
            scan(asyncFrom(items), (s, f) => s + f, 0),
          );
          for (let i = 1; i < results.length; i++) {
            expect(results[i]!.prev).toBe(results[i - 1]!.next);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("each fact matches the corresponding input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 1, maxLength: 30 }),
        async (items) => {
          const results = await collect(
            scan(asyncFrom(items), (s, f) => s + f, 0),
          );
          for (let i = 0; i < items.length; i++) {
            expect(results[i]!.fact).toBe(items[i]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("final next equals fold result", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer(),
        fc.array(fc.integer(), { minLength: 1, maxLength: 30 }),
        async (init, items) => {
          const results = await collect(
            scan(asyncFrom(items), (s, f) => s + f, init),
          );
          const expected = items.reduce((a, b) => a + b, init);
          expect(results[results.length - 1]!.next).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("empty input yields empty output", async () => {
    const results = await collect(
      scan(asyncFrom<number>([]), (s, f) => s + f, 42),
    );
    expect(results).toEqual([]);
  });

  it("works with non-numeric state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 5 }), {
          minLength: 1,
          maxLength: 20,
        }),
        async (items) => {
          const results = await collect(
            scan(
              asyncFrom(items),
              (s: string[], f) => [...s, f],
              [] as string[],
            ),
          );
          // Final state contains all items
          expect(results[results.length - 1]!.next).toEqual(items);
          // Chain is consistent
          for (let i = 1; i < results.length; i++) {
            expect(results[i]!.prev).toBe(results[i - 1]!.next);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── createAsyncQueue ────────────────────────────

describe("createAsyncQueue (property)", () => {
  it("yields all pushed items in FIFO order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { maxLength: 50 }),
        async (items) => {
          const ctrl = new AbortController();
          const queue = createAsyncQueue<number>(ctrl.signal);

          for (const item of items) {
            queue.push(item);
          }
          ctrl.abort();

          const result = await collect(queue);
          expect(result).toEqual(items);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("push after abort is silently dropped", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { maxLength: 20 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 10 }),
        async (before, after) => {
          const ctrl = new AbortController();
          const queue = createAsyncQueue<number>(ctrl.signal);

          for (const item of before) {
            queue.push(item);
          }
          ctrl.abort();

          // Push after abort — should be ignored
          for (const item of after) {
            queue.push(item);
          }

          const result = await collect(queue);
          expect(result).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("pre-aborted signal yields nothing", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const queue = createAsyncQueue<number>(ctrl.signal);
    queue.push(1);
    queue.push(2);
    const result = await collect(queue);
    expect(result).toEqual([]);
  });
});
