import { describe, it, expect } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import type { Epoch } from "../epoch/types.js";
import {
  monoidalView,
  viewPending,
  viewComputing,
  viewReady,
  viewStale,
} from "./types.js";
import type { DerivedView, ViewState } from "./types.js";

// -- Helpers --

/** Trivial Measured that counts epochs. */
const countMeasured: Measured<number, Epoch> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: () => 1,
};

// -- MonoidalView tests --

describe("MonoidalView", () => {
  it("monoidalView factory creates a view with metadata", () => {
    const view = monoidalView({
      name: "epoch-count",
      description: "Counts epochs",
      channel: "test",
      measured: countMeasured,
    });

    expect(view.name).toBe("epoch-count");
    expect(view.description).toBe("Counts epochs");
    expect(view.channels["test"]).toBe(countMeasured);
  });

  it("measured field has correct monoid", () => {
    const view = monoidalView({
      name: "test",
      description: "test view",
      channel: "test",
      measured: countMeasured,
    });

    const m = view.channels["test"]!;
    expect(m.monoid.empty).toBe(0);
    expect(m.monoid.append(2, 3)).toBe(5);
    expect(m.measure({} as Epoch)).toBe(1);
  });
});

// -- DerivedView type tests --

describe("DerivedView", () => {
  it("type is assignable with correct shape", () => {
    // This is a compile-time test — if it compiles,
    // the type works. Runtime just confirms the shape.
    const derived: DerivedView<string, { count: number }> = {
      name: "summary",
      description: "Summarizes count",
      compute: (_tree, deps) => `count: ${deps.count}`,
    };

    expect(derived.name).toBe("summary");
    expect(derived.description).toBe("Summarizes count");
    expect(derived.compute(null as never, { count: 42 })).toBe("count: 42");
  });
});

// -- ViewState tests --

describe("ViewState", () => {
  it("pending state", () => {
    const state = viewPending<number>();

    expect(state.tag).toBe("pending");
    // Type narrowing
    if (state.tag === "pending") {
      // No value field — this should compile
      expect("value" in state).toBe(false);
    }
  });

  it("computing state", () => {
    const state = viewComputing<number>();

    expect(state.tag).toBe("computing");
    if (state.tag === "computing") {
      expect("value" in state).toBe(false);
    }
  });

  it("ready state carries value", () => {
    const state = viewReady(42);

    expect(state.tag).toBe("ready");
    if (state.tag === "ready") {
      expect(state.value).toBe(42);
    }
  });

  it("stale state carries lastValue", () => {
    const state = viewStale("old-data");

    expect(state.tag).toBe("stale");
    if (state.tag === "stale") {
      expect(state.lastValue).toBe("old-data");
    }
  });

  it("type narrowing works across all variants", () => {
    const states: ViewState<number>[] = [
      viewPending(),
      viewComputing(),
      viewReady(99),
      viewStale(50),
    ];

    const tags = states.map((s) => s.tag);
    expect(tags).toEqual(["pending", "computing", "ready", "stale"]);
  });

  it("ready and stale preserve complex values", () => {
    const obj = { x: 1, y: [2, 3] };
    const ready = viewReady(obj);
    const stale = viewStale(obj);

    if (ready.tag === "ready") {
      expect(ready.value).toBe(obj);
    }
    if (stale.tag === "stale") {
      expect(stale.lastValue).toBe(obj);
    }
  });
});
