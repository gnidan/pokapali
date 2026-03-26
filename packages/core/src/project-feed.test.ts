import { describe, it, expect, vi } from "vitest";
import { createFeed } from "./feed.js";
import { projectFeed } from "./project-feed.js";

describe("projectFeed", () => {
  it("projects initial value", () => {
    const source = createFeed({ a: 1, b: "x" });
    const projected = projectFeed(source, (s) => s.a);
    expect(projected.getSnapshot()).toBe(1);
  });

  it("notifies when projected value changes", () => {
    const source = createFeed({ a: 1, b: "x" });
    const projected = projectFeed(source, (s) => s.a);

    const cb = vi.fn();
    projected.subscribe(cb);

    source._update({ a: 2, b: "x" });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(projected.getSnapshot()).toBe(2);
  });

  it("does not notify when projected value" + " is unchanged", () => {
    const source = createFeed({ a: 1, b: "x" });
    const projected = projectFeed(source, (s) => s.a);

    const cb = vi.fn();
    projected.subscribe(cb);

    // b changes but a stays the same
    source._update({ a: 1, b: "y" });
    expect(cb).not.toHaveBeenCalled();
    expect(projected.getSnapshot()).toBe(1);
  });

  it("unsubscribe stops notifications", () => {
    const source = createFeed({ a: 1 });
    const projected = projectFeed(source, (s) => s.a);

    const cb = vi.fn();
    const unsub = projected.subscribe(cb);
    unsub();

    source._update({ a: 2 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("supports custom equality function", () => {
    const source = createFeed({
      items: [1, 2, 3],
    });
    const projected = projectFeed(
      source,
      (s) => s.items,
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    );

    const cb = vi.fn();
    projected.subscribe(cb);

    // Same content, different reference
    source._update({ items: [1, 2, 3] });
    expect(cb).not.toHaveBeenCalled();

    // Different content
    source._update({ items: [1, 2, 4] });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("multiple subscribers work", () => {
    const source = createFeed({ a: 1 });
    const projected = projectFeed(source, (s) => s.a);

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    projected.subscribe(cb1);
    const unsub2 = projected.subscribe(cb2);

    source._update({ a: 2 });
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    unsub2();
    source._update({ a: 3 });
    expect(cb1).toHaveBeenCalledTimes(2);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("getSnapshot reads fresh when" + " no subscribers", () => {
    const source = createFeed({ a: 1 });
    const projected = projectFeed(source, (s) => s.a);

    source._update({ a: 2 });
    // No subscribers, but getSnapshot should
    // still return fresh value
    expect(projected.getSnapshot()).toBe(2);
  });

  it("re-subscribing after full unsubscribe" + " works", () => {
    const source = createFeed({ a: 1 });
    const projected = projectFeed(source, (s) => s.a);

    const cb1 = vi.fn();
    const unsub1 = projected.subscribe(cb1);
    unsub1();

    source._update({ a: 2 });

    const cb2 = vi.fn();
    projected.subscribe(cb2);

    source._update({ a: 3 });
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(projected.getSnapshot()).toBe(3);
  });
});
