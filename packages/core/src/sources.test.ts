/**
 * Tests for sources.ts — merge(), scan(),
 * createAsyncQueue(), and individual source
 * generators (#1, step 3).
 *
 * Level 2 tests: async, isolated, minimal mocks.
 */
import { describe, it, expect } from "vitest";
import {
  merge,
  scan,
  createAsyncQueue,
  reannounceFacts,
  ipnsFacts,
  eventFacts,
} from "./sources.js";

// --- Helper: async iterable from array ---

async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// --- Helper: collect async iterable to array ---

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

// --- Helper: delayed yield ---

async function* delayedFrom<T>(items: T[], delayMs: number): AsyncGenerator<T> {
  for (const item of items) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}

// --- createAsyncQueue tests ---

describe("createAsyncQueue", () => {
  it("yields pushed items in order", async () => {
    const ctrl = new AbortController();
    const queue = createAsyncQueue<number>(ctrl.signal);

    queue.push(1);
    queue.push(2);
    queue.push(3);
    ctrl.abort();

    const items = await collect(queue);
    expect(items).toEqual([1, 2, 3]);
  });

  it("resolves items pushed after iteration", async () => {
    const ctrl = new AbortController();
    const queue = createAsyncQueue<string>(ctrl.signal);

    const result: string[] = [];
    const consumer = (async () => {
      for await (const item of queue) {
        result.push(item);
        if (result.length >= 3) break;
      }
    })();

    // Push asynchronously
    queue.push("a");
    await Promise.resolve();
    queue.push("b");
    await Promise.resolve();
    queue.push("c");

    await consumer;
    expect(result).toEqual(["a", "b", "c"]);
    ctrl.abort();
  });

  it("stops yielding on abort", async () => {
    const ctrl = new AbortController();
    const queue = createAsyncQueue<number>(ctrl.signal);

    queue.push(1);
    queue.push(2);

    const result: number[] = [];
    const consumer = (async () => {
      for await (const item of queue) {
        result.push(item);
      }
    })();

    // Let consumer process pushed items
    await Promise.resolve();
    await Promise.resolve();

    ctrl.abort();
    await consumer;

    expect(result).toEqual([1, 2]);
  });

  it("handles empty queue abort", async () => {
    const ctrl = new AbortController();
    const queue = createAsyncQueue<number>(ctrl.signal);

    const consumer = (async () => {
      const items: number[] = [];
      for await (const item of queue) {
        items.push(item);
      }
      return items;
    })();

    ctrl.abort();
    const result = await consumer;
    expect(result).toEqual([]);
  });
});

// --- merge tests ---

describe("merge", () => {
  it("merges single source unchanged", async () => {
    const items = await collect(merge(asyncFrom([1, 2, 3])));
    expect(items).toEqual([1, 2, 3]);
  });

  it("merges two sources interleaved", async () => {
    const a = asyncFrom(["a1", "a2"]);
    const b = asyncFrom(["b1", "b2"]);

    const items = await collect(merge(a, b));
    // All items present, order may vary
    expect(items).toHaveLength(4);
    expect(items).toContain("a1");
    expect(items).toContain("a2");
    expect(items).toContain("b1");
    expect(items).toContain("b2");
  });

  it("handles source that completes early", async () => {
    const short = asyncFrom([1]);
    const long = asyncFrom([2, 3, 4]);

    const items = await collect(merge(short, long));
    expect(items).toHaveLength(4);
    expect(items).toContain(1);
    expect(items).toContain(4);
  });

  it("handles empty source", async () => {
    const empty = asyncFrom<number>([]);
    const full = asyncFrom([1, 2, 3]);

    const items = await collect(merge(empty, full));
    expect(items).toEqual([1, 2, 3]);
  });

  it("handles all empty sources", async () => {
    const items = await collect(
      merge(asyncFrom<number>([]), asyncFrom<number>([])),
    );
    expect(items).toEqual([]);
  });

  it("merges three sources", async () => {
    const a = asyncFrom(["a"]);
    const b = asyncFrom(["b"]);
    const c = asyncFrom(["c"]);

    const items = await collect(merge(a, b, c));
    expect(items).toHaveLength(3);
    expect(items.sort()).toEqual(["a", "b", "c"]);
  });
});

// --- scan tests ---

describe("scan", () => {
  it("folds with reducer and initial state", async () => {
    const facts = asyncFrom([1, 2, 3]);
    const results = await collect(scan(facts, (s, f) => s + f, 0));

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      prev: 0,
      next: 1,
      fact: 1,
    });
    expect(results[1]).toEqual({
      prev: 1,
      next: 3,
      fact: 2,
    });
    expect(results[2]).toEqual({
      prev: 3,
      next: 6,
      fact: 3,
    });
  });

  it("prev is always previous state", async () => {
    const facts = asyncFrom(["a", "b", "c"]);
    const results = await collect(scan(facts, (s, f) => s + f, ""));

    expect(results[0].prev).toBe("");
    expect(results[0].next).toBe("a");
    expect(results[1].prev).toBe("a");
    expect(results[1].next).toBe("ab");
    expect(results[2].prev).toBe("ab");
    expect(results[2].next).toBe("abc");
  });

  it("yields nothing for empty input", async () => {
    const facts = asyncFrom<number>([]);
    const results = await collect(scan(facts, (s, f) => s + f, 0));
    expect(results).toEqual([]);
  });

  it("accumulator is encapsulated" + " (not shared externally)", async () => {
    const facts = asyncFrom([1, 2, 3]);
    const states: number[] = [];

    for await (const { next } of scan(facts, (s, f) => s + f, 0)) {
      states.push(next);
    }

    // Consumer only sees yielded values —
    // no way to access the internal `let s`
    expect(states).toEqual([1, 3, 6]);
  });

  it("works with object state (immutable)", async () => {
    type State = { count: number; sum: number };
    const init: State = { count: 0, sum: 0 };

    const facts = asyncFrom([10, 20, 30]);
    const results = await collect(
      scan(
        facts,
        (s, f) => ({
          count: s.count + 1,
          sum: s.sum + f,
        }),
        init,
      ),
    );

    expect(results[2].next).toEqual({
      count: 3,
      sum: 60,
    });
    // Original not mutated
    expect(init).toEqual({ count: 0, sum: 0 });
  });
});

// --- Helper: delay ---

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- reannounceFacts tests ---

describe("reannounceFacts", () => {
  it("yields reannounce-tick at intervals", async () => {
    const ac = new AbortController();
    const ticks: { type: string; ts: number }[] = [];
    const iter = reannounceFacts(10, ac.signal);

    for await (const fact of iter) {
      ticks.push(fact);
      if (ticks.length >= 2) {
        ac.abort();
        break;
      }
    }

    expect(ticks).toHaveLength(2);
    expect(ticks[0].type).toBe("reannounce-tick");
    expect(ticks[1].type).toBe("reannounce-tick");
    expect(ticks[1].ts).toBeGreaterThanOrEqual(ticks[0].ts);
  });

  it("terminates when signal aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);

    const result = await collect(reannounceFacts(20, ac.signal));
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it("yields nothing if aborted immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await collect(reannounceFacts(10, ac.signal));
    expect(result).toEqual([]);
  });
});

// --- ipnsFacts tests ---

describe("ipnsFacts", () => {
  it("yields cid-discovered on successful poll", async () => {
    const ac = new AbortController();
    const fakeCid = { toString: () => "baf-test" };
    let calls = 0;
    const poll = async () => {
      calls++;
      if (calls >= 2) ac.abort();
      return fakeCid as any;
    };

    const result = await collect(ipnsFacts(poll, 5, ac.signal));

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].type).toBe("cid-discovered");
    expect((result[0] as any).source).toBe("ipns");
    expect((result[0] as any).cid).toBe(fakeCid);
  });

  it("skips null poll results", async () => {
    const ac = new AbortController();
    let calls = 0;
    const poll = async () => {
      calls++;
      if (calls >= 3) ac.abort();
      return calls === 2 ? ({ toString: () => "cid" } as any) : null;
    };

    const result = await collect(ipnsFacts(poll, 5, ac.signal));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cid-discovered");
  });
});

// --- eventFacts tests ---

describe("eventFacts", () => {
  it("converts events to facts via mapper", async () => {
    const ac = new AbortController();
    type Listener = (val: string) => void;
    let listener: Listener | null = null;

    const subscribe = (cb: Listener) => {
      listener = cb;
    };
    const unsubscribe = (_cb: Listener) => {
      listener = null;
    };

    const gen = eventFacts(
      subscribe,
      unsubscribe,
      (val: string) => ({
        type: "test-event" as const,
        ts: 1000,
        val,
      }),
      ac.signal,
    );

    const iter = gen[Symbol.asyncIterator]();

    await delay(1);
    expect(listener).not.toBeNull();

    listener!("hello");
    listener!("world");

    const r1 = await iter.next();
    expect(r1.value).toEqual({
      type: "test-event",
      ts: 1000,
      val: "hello",
    });

    const r2 = await iter.next();
    expect(r2.value).toEqual({
      type: "test-event",
      ts: 1000,
      val: "world",
    });

    ac.abort();
    await delay(1);
    expect(listener).toBeNull();
  });

  it("cleans up on abort", async () => {
    const ac = new AbortController();
    let subscribed = false;

    const subscribe = (_cb: (v: number) => void) => {
      subscribed = true;
    };
    const unsubscribe = (_cb: (v: number) => void) => {
      subscribed = false;
    };

    const gen = eventFacts(
      subscribe,
      unsubscribe,
      (v: number) => ({
        type: "num" as const,
        ts: 0,
        v,
      }),
      ac.signal,
    );

    const iter = gen[Symbol.asyncIterator]();
    const nextPromise = iter.next();

    await delay(1);
    expect(subscribed).toBe(true);

    ac.abort();
    await nextPromise;
    expect(subscribed).toBe(false);
  });
});
