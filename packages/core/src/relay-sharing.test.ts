import { describe, it, expect, vi, afterEach } from "vitest";
import { createRelaySharing } from "./relay-sharing.js";

function mockAwareness() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    clientID: 1,
    setLocalStateField: vi.fn(),
    getStates: vi.fn(() => new Map()),
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(cb);
    },
    _emit(event: string, ...args: unknown[]) {
      const cbs = listeners.get(event);
      if (cbs) for (const cb of cbs) cb(...args);
    },
  };
}

describe("createRelaySharing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes relay entries to awareness", () => {
    vi.useFakeTimers();
    const awareness = mockAwareness();
    const rd = {
      relayEntries: vi.fn(() => [
        {
          peerId: "p1",
          addrs: ["/ip4/1.2.3.4"],
        },
      ]),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    // Initial publish fires after 5s delay
    vi.advanceTimersByTime(5_000);
    expect(awareness.setLocalStateField).toHaveBeenCalledWith("relays", [
      {
        peerId: "p1",
        addrs: ["/ip4/1.2.3.4"],
      },
    ]);

    sharing.destroy();
  });

  it("consumes relay entries from other peers", () => {
    const awareness = mockAwareness();
    const states = new Map();
    states.set(1, {}); // self — no relays
    states.set(2, {
      relays: [
        {
          peerId: "p2",
          addrs: ["/ip4/5.6.7.8"],
        },
      ],
    });
    awareness.getStates = vi.fn(() => states);

    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    // Simulate awareness update
    awareness._emit("update");

    expect(rd.addExternalRelays).toHaveBeenCalledWith([
      {
        peerId: "p2",
        addrs: ["/ip4/5.6.7.8"],
      },
    ]);

    sharing.destroy();
  });

  it("destroy clears timers", () => {
    vi.useFakeTimers();
    const awareness = mockAwareness();
    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });
    sharing.destroy();

    // Advancing time should not cause errors
    vi.advanceTimersByTime(60_000);
  });

  it("publishes periodically every 30s", () => {
    vi.useFakeTimers();
    const awareness = mockAwareness();
    const rd = {
      relayEntries: vi.fn(() => [{ peerId: "p1", addrs: ["/ip4/1.2.3.4"] }]),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    // Initial publish after 5s
    vi.advanceTimersByTime(5_000);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(1);

    // Periodic at 30s (from creation, not from
    // initial publish)
    vi.advanceTimersByTime(25_000);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(2);

    // Another cycle at 60s
    vi.advanceTimersByTime(30_000);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(3);

    sharing.destroy();
  });

  it("does not publish when relayEntries is " + "empty", () => {
    vi.useFakeTimers();
    const awareness = mockAwareness();
    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    vi.advanceTimersByTime(5_000);
    expect(awareness.setLocalStateField).not.toHaveBeenCalled();

    sharing.destroy();
  });

  it("skips non-array relays in awareness", () => {
    const awareness = mockAwareness();
    const states = new Map();
    states.set(1, {}); // self
    states.set(2, { relays: "not-an-array" });
    states.set(3, { relays: 42 });
    states.set(4, { relays: null });
    awareness.getStates = vi.fn(() => states);

    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    awareness._emit("update");
    expect(rd.addExternalRelays).not.toHaveBeenCalled();

    sharing.destroy();
  });

  it("skips empty relays array from peer", () => {
    const awareness = mockAwareness();
    const states = new Map();
    states.set(1, {}); // self
    states.set(2, { relays: [] });
    awareness.getStates = vi.fn(() => states);

    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    awareness._emit("update");
    expect(rd.addExternalRelays).not.toHaveBeenCalled();

    sharing.destroy();
  });

  it("consumes relays from multiple peers in " + "single update", () => {
    const awareness = mockAwareness();
    const states = new Map();
    states.set(1, {}); // self
    states.set(2, {
      relays: [{ peerId: "p2", addrs: ["/ip4/2.2.2.2"] }],
    });
    states.set(3, {
      relays: [{ peerId: "p3", addrs: ["/ip4/3.3.3.3"] }],
    });
    awareness.getStates = vi.fn(() => states);

    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });

    awareness._emit("update");
    expect(rd.addExternalRelays).toHaveBeenCalledTimes(2);

    sharing.destroy();
  });

  it("destroy removes awareness update listener", () => {
    vi.useFakeTimers();
    const awareness = mockAwareness();
    const rd = {
      relayEntries: vi.fn(() => []),
      addExternalRelays: vi.fn(),
    };

    const sharing = createRelaySharing({
      awareness: awareness as any,
      roomDiscovery: rd as any,
    });
    sharing.destroy();

    // Set up state with relays after destroy
    const states = new Map();
    states.set(2, {
      relays: [{ peerId: "p2", addrs: ["/ip4/2.2.2.2"] }],
    });
    awareness.getStates = vi.fn(() => states);

    // Emit update — should not call
    // addExternalRelays since listener removed
    awareness._emit("update");
    expect(rd.addExternalRelays).not.toHaveBeenCalled();
  });
});
