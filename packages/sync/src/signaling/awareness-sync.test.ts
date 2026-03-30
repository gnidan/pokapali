import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { syncAwareness } from "./awareness-sync.js";

// -------------------------------------------------------
// Mock DataChannel
// -------------------------------------------------------

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

type Handler = Function;

interface MockDataChannel {
  readyState: string;
  send: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  /** Simulate receiving a message */
  receiveMessage(data: ArrayBuffer): void;
  /** Simulate channel opening */
  open(): void;
  /** Get registered listeners by event name */
  listeners: Map<string, Set<Handler>>;
}

/* eslint-enable @typescript-eslint/no-unsafe-function-type */

function createMockDataChannel(initialState = "open"): MockDataChannel {
  const listeners = new Map<string, Set<Handler>>();

  const dc: MockDataChannel = {
    readyState: initialState,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: Handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: Handler) => {
      listeners.get(event)?.delete(handler);
    }),
    close: vi.fn(),
    listeners,
    receiveMessage(data: ArrayBuffer) {
      const handlers = listeners.get("message");
      if (handlers) {
        for (const h of handlers) {
          (h as (evt: { data: ArrayBuffer }) => void)({ data });
        }
      }
    },
    open() {
      dc.readyState = "open";
      const handlers = listeners.get("open");
      if (handlers) {
        for (const h of handlers) {
          (h as () => void)();
        }
      }
    },
  };

  return dc;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("awareness sync", () => {
  it("sends full state on connect when DC is open", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const dc = createMockDataChannel("open");

    syncAwareness(awareness, dc as unknown as RTCDataChannel);

    // Should have sent initial full state
    expect(dc.send).toHaveBeenCalledOnce();
    const sent = dc.send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(Uint8Array);

    doc.destroy();
  });

  it("defers full state until DC opens", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const dc = createMockDataChannel("connecting");

    syncAwareness(awareness, dc as unknown as RTCDataChannel);

    // Should NOT have sent yet
    expect(dc.send).not.toHaveBeenCalled();

    // Now open
    dc.open();
    expect(dc.send).toHaveBeenCalledOnce();

    doc.destroy();
  });

  it("sends awareness update when local state " + "changes", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const dc = createMockDataChannel("open");

    syncAwareness(awareness, dc as unknown as RTCDataChannel);

    // Clear initial full-state send
    dc.send.mockClear();

    // Change local awareness state
    awareness.setLocalState({ cursor: { x: 1 } });

    expect(dc.send).toHaveBeenCalledOnce();

    doc.destroy();
  });

  it("applies incoming awareness update", () => {
    // Create two awareness instances
    const doc1 = new Y.Doc();
    const awareness1 = new Awareness(doc1);
    const doc2 = new Y.Doc();
    const awareness2 = new Awareness(doc2);

    const dc1 = createMockDataChannel("open");
    const dc2 = createMockDataChannel("open");

    syncAwareness(awareness1, dc1 as unknown as RTCDataChannel);
    syncAwareness(awareness2, dc2 as unknown as RTCDataChannel);

    // Clear initial sends
    dc1.send.mockClear();
    dc2.send.mockClear();

    // Set state on awareness1
    awareness1.setLocalState({ name: "Alice" });

    // Get the encoded update that was sent
    const encoded = dc1.send.mock.calls[0]![0] as Uint8Array;

    // Deliver to awareness2
    dc2.receiveMessage(encoded.buffer as ArrayBuffer);

    // awareness2 should now have awareness1's
    // state
    const states = awareness2.getStates();
    expect(states.get(doc1.clientID)).toEqual({
      name: "Alice",
    });

    doc1.destroy();
    doc2.destroy();
  });

  it("cleanup removes listeners", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const dc = createMockDataChannel("open");

    const cleanup = syncAwareness(awareness, dc as unknown as RTCDataChannel);

    cleanup();

    // DC event listeners should have been
    // removed
    expect(dc.removeEventListener).toHaveBeenCalled();

    // Awareness changes should no longer send
    dc.send.mockClear();
    awareness.setLocalState({ cursor: null });
    expect(dc.send).not.toHaveBeenCalled();

    doc.destroy();
  });
});
