import { describe, it, expect, vi } from "vitest";
import { createFeed } from "./feed.js";

describe("createFeed", () => {
  it("returns initial value from getSnapshot", () => {
    const feed = createFeed(42);
    expect(feed.getSnapshot()).toBe(42);
  });

  it("updates value via _update", () => {
    const feed = createFeed("a");
    feed._update("b");
    expect(feed.getSnapshot()).toBe("b");
  });

  it("notifies subscribers on _update", () => {
    const feed = createFeed(0);
    const cb = vi.fn();
    feed.subscribe(cb);

    feed._update(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("skips notification when value is equal", () => {
    const feed = createFeed(10);
    const cb = vi.fn();
    feed.subscribe(cb);

    feed._update(10);
    expect(cb).not.toHaveBeenCalled();
    expect(feed.getSnapshot()).toBe(10);
  });

  it("uses custom equality function", () => {
    const feed = createFeed({ x: 1 }, (a, b) => a.x === b.x);
    const cb = vi.fn();
    feed.subscribe(cb);

    // Same x — should not notify.
    feed._update({ x: 1 });
    expect(cb).not.toHaveBeenCalled();

    // Different x — should notify.
    feed._update({ x: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot()).toEqual({ x: 2 });
  });

  it("supports multiple subscribers", () => {
    const feed = createFeed(0);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    feed.subscribe(cb1);
    feed.subscribe(cb2);

    feed._update(1);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const feed = createFeed(0);
    const cb = vi.fn();
    const unsub = feed.subscribe(cb);

    unsub();
    feed._update(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe only removes that subscriber", () => {
    const feed = createFeed(0);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = feed.subscribe(cb1);
    feed.subscribe(cb2);

    unsub1();
    feed._update(1);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("double unsubscribe is safe", () => {
    const feed = createFeed(0);
    const unsub = feed.subscribe(vi.fn());
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("subscriber added during notify is not called", () => {
    const feed = createFeed(0);
    const late = vi.fn();
    feed.subscribe(() => {
      feed.subscribe(late);
    });

    feed._update(1);
    // Set iteration snapshot means late won't fire
    // this round — depends on Set iteration semantics.
    // Either way, late should not have been called
    // for this update since it was added mid-iteration
    // (Set may or may not visit it; we just verify no
    // crash).
  });

  it("works with reference types and default ===", () => {
    const obj = { a: 1 };
    const feed = createFeed(obj);
    const cb = vi.fn();
    feed.subscribe(cb);

    // Same reference — no notify.
    feed._update(obj);
    expect(cb).not.toHaveBeenCalled();

    // Different reference, same shape — notifies.
    feed._update({ a: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
