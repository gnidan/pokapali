import { describe, it, expect, vi, afterEach, } from "vitest";
import { createRelaySharing } from "./relay-sharing.js";
function mockAwareness() {
    const listeners = new Map();
    return {
        clientID: 1,
        setLocalStateField: vi.fn(),
        getStates: vi.fn(() => new Map()),
        on(event, cb) {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event).add(cb);
        },
        off(event, cb) {
            listeners.get(event)?.delete(cb);
        },
        _emit(event, ...args) {
            const cbs = listeners.get(event);
            if (cbs)
                for (const cb of cbs)
                    cb(...args);
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
            awareness: awareness,
            roomDiscovery: rd,
        });
        // Initial publish fires after 5s delay
        vi.advanceTimersByTime(5_000);
        expect(awareness.setLocalStateField).toHaveBeenCalledWith("relays", [{
                peerId: "p1",
                addrs: ["/ip4/1.2.3.4"],
            }]);
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
            awareness: awareness,
            roomDiscovery: rd,
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
            awareness: awareness,
            roomDiscovery: rd,
        });
        sharing.destroy();
        // Advancing time should not cause errors
        vi.advanceTimersByTime(60_000);
    });
});
//# sourceMappingURL=relay-sharing.test.js.map