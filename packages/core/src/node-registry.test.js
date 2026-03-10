import { describe, it, expect, vi, beforeEach, afterEach, } from "vitest";
import { createNodeRegistry, acquireNodeRegistry, getNodeRegistry, _resetNodeRegistry, NODE_CAPS_TOPIC, } from "./node-registry.js";
function makePubsub() {
    const handlers = new Map();
    return {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        publish: vi.fn().mockResolvedValue(undefined),
        addEventListener(type, fn) {
            if (!handlers.has(type)) {
                handlers.set(type, new Set());
            }
            handlers.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            handlers.get(type)?.delete(fn);
        },
        _emit(type, detail) {
            for (const fn of handlers.get(type) ?? []) {
                fn({ detail });
            }
        },
        _handlers: handlers,
    };
}
function capsMessage(peerId, roles) {
    return new TextEncoder().encode(JSON.stringify({
        version: 1,
        peerId,
        roles,
    }));
}
function makeHelia(connectedPeerIds = []) {
    return {
        libp2p: {
            getConnections: () => connectedPeerIds.map((pid) => ({
                remotePeer: { toString: () => pid },
            })),
        },
    };
}
describe("createNodeRegistry", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it("subscribes to caps topic", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        const reg = createNodeRegistry(pubsub, () => helia);
        expect(pubsub.subscribe).toHaveBeenCalledWith(NODE_CAPS_TOPIC);
        reg.destroy();
    });
    it("tracks nodes from caps messages", () => {
        const pubsub = makePubsub();
        const helia = makeHelia(["peer-A"]);
        const reg = createNodeRegistry(pubsub, () => helia);
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: capsMessage("peer-A", ["relay", "pinner"]),
        });
        expect(reg.nodes.size).toBe(1);
        const node = reg.nodes.get("peer-A");
        expect(node.peerId).toBe("peer-A");
        expect(node.roles).toEqual(["relay", "pinner"]);
        expect(node.connected).toBe(true);
        expect(node.lastSeenAt).toBeGreaterThan(0);
        reg.destroy();
    });
    it("marks disconnected nodes correctly", () => {
        const pubsub = makePubsub();
        const helia = makeHelia([]); // no connections
        const reg = createNodeRegistry(pubsub, () => helia);
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: capsMessage("peer-B", ["relay"]),
        });
        const node = reg.nodes.get("peer-B");
        expect(node.connected).toBe(false);
        reg.destroy();
    });
    it("ignores messages on other topics", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        const reg = createNodeRegistry(pubsub, () => helia);
        pubsub._emit("message", {
            topic: "other-topic",
            data: capsMessage("peer-C", ["relay"]),
        });
        expect(reg.nodes.size).toBe(0);
        reg.destroy();
    });
    it("ignores malformed messages", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        const reg = createNodeRegistry(pubsub, () => helia);
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: new TextEncoder().encode("not json{"),
        });
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: new TextEncoder().encode(JSON.stringify({ version: 2 })),
        });
        expect(reg.nodes.size).toBe(0);
        reg.destroy();
    });
    it("prunes stale entries after 90s", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        const reg = createNodeRegistry(pubsub, () => helia);
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: capsMessage("peer-D", ["relay"]),
        });
        expect(reg.nodes.size).toBe(1);
        // Advance past stale threshold (90s) +
        // prune interval (30s)
        vi.advanceTimersByTime(120_000);
        expect(reg.nodes.size).toBe(0);
        reg.destroy();
    });
    it("updates existing node on re-announce", () => {
        const pubsub = makePubsub();
        const helia = makeHelia(["peer-E"]);
        const reg = createNodeRegistry(pubsub, () => helia);
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: capsMessage("peer-E", ["relay"]),
        });
        const firstSeen = reg.nodes.get("peer-E").lastSeenAt;
        vi.advanceTimersByTime(30_000);
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: capsMessage("peer-E", ["relay", "pinner"]),
        });
        const node = reg.nodes.get("peer-E");
        expect(node.roles).toEqual(["relay", "pinner"]);
        expect(node.lastSeenAt).toBeGreaterThan(firstSeen);
        reg.destroy();
    });
    it("destroy removes listener and stops"
        + " prune timer", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        const reg = createNodeRegistry(pubsub, () => helia);
        // Add a node, then destroy
        pubsub._emit("message", {
            topic: NODE_CAPS_TOPIC,
            data: capsMessage("peer-F", ["relay"]),
        });
        expect(reg.nodes.size).toBe(1);
        reg.destroy();
        // After destroy, new messages should not
        // be processed (listener removed)
        expect(pubsub._handlers.get("message")?.size ?? 0).toBe(0);
    });
});
describe("singleton management", () => {
    afterEach(() => {
        _resetNodeRegistry();
    });
    it("acquireNodeRegistry returns same"
        + " instance", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        const r1 = acquireNodeRegistry(pubsub, () => helia);
        const r2 = acquireNodeRegistry(pubsub, () => helia);
        expect(r1).toBe(r2);
    });
    it("getNodeRegistry returns null before"
        + " acquire", () => {
        expect(getNodeRegistry()).toBeNull();
    });
    it("getNodeRegistry returns instance after"
        + " acquire", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        acquireNodeRegistry(pubsub, () => helia);
        expect(getNodeRegistry()).not.toBeNull();
    });
    it("_resetNodeRegistry clears singleton", () => {
        const pubsub = makePubsub();
        const helia = makeHelia();
        acquireNodeRegistry(pubsub, () => helia);
        _resetNodeRegistry();
        expect(getNodeRegistry()).toBeNull();
    });
});
//# sourceMappingURL=node-registry.test.js.map