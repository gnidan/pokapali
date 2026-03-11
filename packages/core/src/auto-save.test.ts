import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutoSaver } from "./auto-save.js";

// Minimal mock of CollabDoc for auto-save purposes.
function mockDoc(opts?: { canPush?: boolean; saveState?: string }) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    capability: {
      canPushSnapshots: opts?.canPush ?? true,
    },
    saveState: opts?.saveState ?? "saved",
    publish: vi.fn().mockResolvedValue(undefined),
    on(event: string, fn: (...args: any[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: any[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    _emit(event: string) {
      for (const fn of listeners.get(event) ?? []) {
        fn();
      }
    },
    _listeners: listeners,
  };
}

// Minimal EventTarget for window/document stubs.
function makeTarget() {
  const handlers = new Map<string, Set<(e: any) => void>>();
  return {
    addEventListener(type: string, fn: (e: any) => void) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      handlers.get(type)?.delete(fn);
    },
    _dispatch(type: string, event?: any) {
      for (const fn of handlers.get(type) ?? []) {
        fn(event ?? { type });
      }
    },
    _handlers: handlers,
  };
}

describe("createAutoSaver", () => {
  let windowStub: ReturnType<typeof makeTarget>;
  let documentStub: ReturnType<typeof makeTarget> & {
    visibilityState: string;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    windowStub = makeTarget();
    documentStub = Object.assign(makeTarget(), {
      visibilityState: "visible" as string,
    });
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", documentStub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns no-op cleanup when" + " canPushSnapshots is false", () => {
    const doc = mockDoc({ canPush: false });
    const cleanup = createAutoSaver(doc as any);
    expect(doc._listeners.size).toBe(0);
    cleanup();
  });

  it("debounces publish-needed into one" + " publish call", async () => {
    const doc = mockDoc({ saveState: "dirty" });
    const cleanup = createAutoSaver(doc as any, {
      debounceMs: 500,
    });

    doc._emit("publish-needed");
    doc._emit("publish-needed");
    doc._emit("publish-needed");

    expect(doc.publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(doc.publish).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("resets debounce timer on each new" + " event", async () => {
    const doc = mockDoc({ saveState: "dirty" });
    const cleanup = createAutoSaver(doc as any, {
      debounceMs: 500,
    });

    doc._emit("publish-needed");
    await vi.advanceTimersByTimeAsync(400);
    expect(doc.publish).not.toHaveBeenCalled();

    // Fire again — timer resets
    doc._emit("publish-needed");
    await vi.advanceTimersByTimeAsync(400);
    expect(doc.publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(doc.publish).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("does not crash when publish" + " rejects", async () => {
    const doc = mockDoc({ saveState: "dirty" });
    doc.publish.mockRejectedValue(new Error("network error"));
    const cleanup = createAutoSaver(doc as any, {
      debounceMs: 100,
    });

    doc._emit("publish-needed");
    await vi.advanceTimersByTimeAsync(100);

    expect(doc.publish).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("visibilitychange to hidden triggers" + " immediate publish", () => {
    const doc = mockDoc({
      saveState: "dirty",
    });
    const cleanup = createAutoSaver(doc as any);

    documentStub.visibilityState = "hidden";
    documentStub._dispatch("visibilitychange");

    expect(doc.publish).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("skips visibilitychange save when" + " saved", () => {
    const doc = mockDoc({ saveState: "saved" });
    const cleanup = createAutoSaver(doc as any);

    documentStub.visibilityState = "hidden";
    documentStub._dispatch("visibilitychange");

    expect(doc.publish).not.toHaveBeenCalled();

    cleanup();
  });

  it("beforeunload calls preventDefault when" + " dirty", () => {
    const doc = mockDoc({
      saveState: "dirty",
    });
    const cleanup = createAutoSaver(doc as any);

    const event = {
      type: "beforeunload",
      preventDefault: vi.fn(),
    };
    windowStub._dispatch("beforeunload", event);

    expect(event.preventDefault).toHaveBeenCalled();

    cleanup();
  });

  it("beforeunload does not preventDefault" + " when saved", () => {
    const doc = mockDoc({ saveState: "saved" });
    const cleanup = createAutoSaver(doc as any);

    const event = {
      type: "beforeunload",
      preventDefault: vi.fn(),
    };
    windowStub._dispatch("beforeunload", event);

    expect(event.preventDefault).not.toHaveBeenCalled();

    cleanup();
  });

  it("cleanup removes listeners and clears" + " debounce timer", async () => {
    const doc = mockDoc();
    const cleanup = createAutoSaver(doc as any, {
      debounceMs: 500,
    });

    doc._emit("publish-needed");
    cleanup();

    await vi.advanceTimersByTimeAsync(500);
    expect(doc.publish).not.toHaveBeenCalled();

    // Doc listener removed
    expect(doc._listeners.get("publish-needed")?.size ?? 0).toBe(0);

    // Window/document listeners removed
    expect(windowStub._handlers.get("beforeunload")?.size ?? 0).toBe(0);
    expect(documentStub._handlers.get("visibilitychange")?.size ?? 0).toBe(0);
  });

  it("cleanup is safe to call twice", () => {
    const doc = mockDoc();
    const cleanup = createAutoSaver(doc as any);
    cleanup();
    cleanup();
  });

  it("visibilitychange clears pending debounce" + " timer", async () => {
    const doc = mockDoc({
      saveState: "dirty",
    });
    const cleanup = createAutoSaver(doc as any, {
      debounceMs: 500,
    });

    doc._emit("publish-needed");

    // Visibility change triggers immediate save
    // and clears pending debounce
    documentStub.visibilityState = "hidden";
    documentStub._dispatch("visibilitychange");

    expect(doc.publish).toHaveBeenCalledTimes(1);

    // Advance past original debounce — no second push
    await vi.advanceTimersByTimeAsync(500);
    expect(doc.publish).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
