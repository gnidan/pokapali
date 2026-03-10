import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  createNodeRegistry,
  acquireNodeRegistry,
  getNodeRegistry,
  _resetNodeRegistry,
  NODE_CAPS_TOPIC,
} from "./node-registry.js";

function makePubsub() {
  const handlers = new Map<
    string,
    Set<(evt: any) => void>
  >();
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
    addEventListener(
      type: string,
      fn: (evt: any) => void,
    ) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type)!.add(fn);
    },
    removeEventListener(
      type: string,
      fn: (evt: any) => void,
    ) {
      handlers.get(type)?.delete(fn);
    },
    _emit(type: string, detail: any) {
      for (const fn of
        handlers.get(type) ?? []
      ) {
        fn({ detail } as any);
      }
    },
    _handlers: handlers,
  };
}

function capsMessage(
  peerId: string,
  roles: string[],
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      peerId,
      roles,
    }),
  );
}

function capsMessageV2(
  peerId: string,
  roles: string[],
  neighbors: { peerId: string; role?: string }[],
  browserCount?: number,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      peerId,
      roles,
      neighbors,
      browserCount,
    }),
  );
}

function makeHelia(
  connectedPeerIds: string[] = [],
) {
  return {
    libp2p: {
      getConnections: () =>
        connectedPeerIds.map((pid) => ({
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
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    expect(pubsub.subscribe).toHaveBeenCalledWith(
      NODE_CAPS_TOPIC,
    );

    reg.destroy();
  });

  it("tracks nodes from caps messages", () => {
    const pubsub = makePubsub();
    const helia = makeHelia(["peer-A"]);
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage(
        "peer-A",
        ["relay", "pinner"],
      ),
    });

    expect(reg.nodes.size).toBe(1);
    const node = reg.nodes.get("peer-A")!;
    expect(node.peerId).toBe("peer-A");
    expect(node.roles).toEqual(
      ["relay", "pinner"],
    );
    expect(node.connected).toBe(true);
    expect(node.lastSeenAt).toBeGreaterThan(0);

    reg.destroy();
  });

  it("marks disconnected nodes correctly", () => {
    const pubsub = makePubsub();
    const helia = makeHelia([]); // no connections
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-B", ["relay"]),
    });

    const node = reg.nodes.get("peer-B")!;
    expect(node.connected).toBe(false);

    reg.destroy();
  });

  it("ignores messages on other topics", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

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
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: new TextEncoder().encode("not json{"),
    });

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: new TextEncoder().encode(
        JSON.stringify({ version: 99 }),
      ),
    });

    expect(reg.nodes.size).toBe(0);

    reg.destroy();
  });

  it("prunes stale entries after 90s", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

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
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-E", ["relay"]),
    });

    const firstSeen =
      reg.nodes.get("peer-E")!.lastSeenAt;

    vi.advanceTimersByTime(30_000);

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage(
        "peer-E",
        ["relay", "pinner"],
      ),
    });

    const node = reg.nodes.get("peer-E")!;
    expect(node.roles).toEqual(
      ["relay", "pinner"],
    );
    expect(node.lastSeenAt).toBeGreaterThan(
      firstSeen,
    );

    reg.destroy();
  });

  it("parses v2 message with neighbors and"
    + " browserCount", () => {
    const pubsub = makePubsub();
    const helia = makeHelia(["relay-A"]);
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessageV2(
        "relay-A",
        ["relay"],
        [
          { peerId: "browser-1", role: "browser" },
          { peerId: "browser-2" },
        ],
        3,
      ),
    });

    const node = reg.nodes.get("relay-A")!;
    expect(node.neighbors).toEqual([
      { peerId: "browser-1", role: "browser" },
      { peerId: "browser-2" },
    ]);
    expect(node.browserCount).toBe(3);

    reg.destroy();
  });

  it("v1 messages have empty neighbors", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-V1", ["relay"]),
    });

    const node = reg.nodes.get("peer-V1")!;
    expect(node.neighbors).toEqual([]);
    expect(node.browserCount).toBeUndefined();

    reg.destroy();
  });

  it("prunes stale node and its topology"
    + " edges", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessageV2(
        "relay-X",
        ["relay"],
        [{ peerId: "browser-99" }],
        1,
      ),
    });
    expect(reg.nodes.size).toBe(1);
    expect(
      reg.nodes.get("relay-X")!.neighbors,
    ).toHaveLength(1);

    // Advance past stale threshold + prune interval
    vi.advanceTimersByTime(120_000);

    expect(reg.nodes.size).toBe(0);

    reg.destroy();
  });

  it("fires onNodeChange for new node", () => {
    const pubsub = makePubsub();
    const helia = makeHelia(["peer-A"]);
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const cb = vi.fn();
    reg.onNodeChange(cb);

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });

    expect(cb).toHaveBeenCalledTimes(1);

    reg.destroy();
  });

  it("fires onNodeChange when roles change", () => {
    const pubsub = makePubsub();
    const helia = makeHelia(["peer-A"]);
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const cb = vi.fn();

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });

    reg.onNodeChange(cb);

    // Same roles — no change
    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });
    expect(cb).not.toHaveBeenCalled();

    // Different roles — fires
    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage(
        "peer-A", ["relay", "pinner"],
      ),
    });
    expect(cb).toHaveBeenCalledTimes(1);

    reg.destroy();
  });

  it("fires onNodeChange when connected state"
    + " changes", () => {
    const pubsub = makePubsub();
    let connectedPeers: string[] = [];
    const helia = {
      libp2p: {
        getConnections: () =>
          connectedPeers.map((pid) => ({
            remotePeer: { toString: () => pid },
          })),
      },
    };
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const cb = vi.fn();

    // First message: disconnected
    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });

    reg.onNodeChange(cb);

    // Same state — no fire
    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });
    expect(cb).not.toHaveBeenCalled();

    // Now connected — fires
    connectedPeers = ["peer-A"];
    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });
    expect(cb).toHaveBeenCalledTimes(1);

    reg.destroy();
  });

  it("does not fire onNodeChange for unchanged"
    + " re-announce", () => {
    const pubsub = makePubsub();
    const helia = makeHelia(["peer-A"]);
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const cb = vi.fn();

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });

    reg.onNodeChange(cb);

    // Identical re-announce
    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });

    expect(cb).not.toHaveBeenCalled();

    reg.destroy();
  });

  it("fires onNodeChange on stale prune", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const cb = vi.fn();

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });
    reg.onNodeChange(cb);

    // Advance past stale + prune interval
    vi.advanceTimersByTime(120_000);
    expect(cb).toHaveBeenCalledTimes(1);

    reg.destroy();
  });

  it("offNodeChange unregisters callback", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const cb = vi.fn();
    reg.onNodeChange(cb);
    reg.offNodeChange(cb);

    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-A", ["relay"]),
    });

    expect(cb).not.toHaveBeenCalled();

    reg.destroy();
  });

  it("destroy clears change listeners", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const cb = vi.fn();
    reg.onNodeChange(cb);
    reg.destroy();

    // After destroy, callback should not fire
    // (pubsub listener removed, so no new messages)
    // Just verify no errors on offNodeChange
    reg.offNodeChange(cb);
  });

  it("destroy removes listener and stops"
    + " prune timer", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    const reg = createNodeRegistry(
      pubsub as any,
      () => helia as any,
    );

    // Add a node, then destroy
    pubsub._emit("message", {
      topic: NODE_CAPS_TOPIC,
      data: capsMessage("peer-F", ["relay"]),
    });
    expect(reg.nodes.size).toBe(1);

    reg.destroy();

    // After destroy, new messages should not
    // be processed (listener removed)
    expect(
      pubsub._handlers.get("message")?.size ?? 0,
    ).toBe(0);
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
    const r1 = acquireNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    const r2 = acquireNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
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
    acquireNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    expect(getNodeRegistry()).not.toBeNull();
  });

  it("_resetNodeRegistry clears singleton", () => {
    const pubsub = makePubsub();
    const helia = makeHelia();
    acquireNodeRegistry(
      pubsub as any,
      () => helia as any,
    );
    _resetNodeRegistry();
    expect(getNodeRegistry()).toBeNull();
  });
});
