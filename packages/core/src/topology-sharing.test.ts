import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTopologySharing } from "./topology-sharing.js";
import type { KnownNode } from "./node-registry.js";

function makeNode(
  peerId: string,
  roles: string[],
  connected: boolean,
  neighbors: { peerId: string; role?: string }[] = [],
  browserCount?: number,
): KnownNode {
  return {
    peerId,
    roles,
    lastSeenAt: Date.now(),
    connected,
    neighbors,
    browserCount,
    addrs: [],
    stale: false,
    httpUrl: undefined,
  };
}

function makeRegistry(nodes: KnownNode[] = []) {
  const map = new Map<string, KnownNode>();
  for (const n of nodes) map.set(n.peerId, n);
  const changeCbs = new Set<() => void>();
  return {
    nodes: map as ReadonlyMap<string, KnownNode>,
    onNodeChange: vi.fn((cb: () => void) => changeCbs.add(cb)),
    offNodeChange: vi.fn((cb: () => void) => changeCbs.delete(cb)),
    destroy: vi.fn(),
    _changeCbs: changeCbs,
    _fireChange() {
      for (const cb of changeCbs) cb();
    },
  };
}

function makeAwareness() {
  const fields: Record<string, unknown> = {};
  return {
    setLocalStateField: vi.fn((key: string, val: unknown) => {
      fields[key] = val;
    }),
    _fields: fields,
  };
}

function makeLibp2p() {
  const handlers = new Map<string, Set<(evt: any) => void>>();
  return {
    addEventListener(type: string, fn: (evt: any) => void) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (evt: any) => void) {
      handlers.get(type)?.delete(fn);
    },
    _dispatch(type: string, evt?: any) {
      for (const fn of handlers.get(type) ?? []) {
        fn(evt ?? {});
      }
    },
    _handlers: handlers,
  };
}

describe("createTopologySharing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes connected relays after initial" + " delay", () => {
    const registry = makeRegistry([
      makeNode("relay-A", ["relay"], true),
      makeNode("relay-B", ["relay"], false),
      makeNode("pinner-C", ["relay", "pinner"], true),
    ]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    // Before initial delay — nothing published
    expect(awareness.setLocalStateField).not.toHaveBeenCalled();

    // After 2s initial delay
    vi.advanceTimersByTime(2_000);

    const topo = awareness._fields.topology as any;
    expect(topo.connectedRelays).toEqual(["relay-A", "pinner-C"]);
    expect(topo.relayRoles).toEqual({
      "relay-A": ["relay"],
      "pinner-C": ["relay", "pinner"],
    });

    ts.destroy();
  });

  it("debounces peer connect events", () => {
    const registry = makeRegistry([makeNode("relay-A", ["relay"], true)]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    // Trigger initial
    vi.advanceTimersByTime(2_000);
    awareness.setLocalStateField.mockClear();

    // Fire connect events rapidly
    libp2p._dispatch("peer:connect");
    libp2p._dispatch("peer:connect");
    libp2p._dispatch("peer:connect");

    // Not yet — debouncing
    expect(awareness.setLocalStateField).not.toHaveBeenCalled();

    // After 2s debounce
    vi.advanceTimersByTime(2_000);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(1);

    ts.destroy();
  });

  it("publishes periodically every 30s", () => {
    const registry = makeRegistry([makeNode("relay-A", ["relay"], true)]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    // Initial + periodic
    vi.advanceTimersByTime(2_000);
    awareness.setLocalStateField.mockClear();

    vi.advanceTimersByTime(30_000);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(1);

    ts.destroy();
  });

  it("publishNow forces immediate publish", () => {
    const registry = makeRegistry([makeNode("relay-A", ["relay"], true)]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    ts.publishNow();
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(1);

    ts.destroy();
  });

  it("excludes non-relay non-pinner from" + " connectedRelays", () => {
    const registry = makeRegistry([
      makeNode("browser-X", ["browser"], true),
      makeNode("relay-A", ["relay"], true),
    ]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    ts.publishNow();
    const topo = awareness._fields.topology as any;
    expect(topo.connectedRelays).toEqual(["relay-A"]);

    ts.destroy();
  });

  it("publishes knownNodes from registry", () => {
    const registry = makeRegistry([
      makeNode(
        "relay-A",
        ["relay"],
        true,
        [{ peerId: "relay-B", role: "relay" }],
        2,
      ),
      makeNode("pinner-C", ["pinner"], false),
    ]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    ts.publishNow();
    const topo = awareness._fields.topology as any;
    expect(topo.knownNodes).toHaveLength(2);

    const nodeA = topo.knownNodes.find((n: any) => n.peerId === "relay-A");
    expect(nodeA).toEqual({
      peerId: "relay-A",
      roles: ["relay"],
      neighbors: [{ peerId: "relay-B", role: "relay" }],
      browserCount: 2,
    });

    const nodeC = topo.knownNodes.find((n: any) => n.peerId === "pinner-C");
    expect(nodeC).toEqual({
      peerId: "pinner-C",
      roles: ["pinner"],
      neighbors: [],
    });
    // browserCount omitted when undefined
    expect(nodeC.browserCount).toBeUndefined();

    ts.destroy();
  });

  it("includes all nodes in knownNodes not" + " just connected", () => {
    const registry = makeRegistry([
      makeNode("relay-A", ["relay"], true),
      makeNode("relay-B", ["relay"], false),
    ]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    ts.publishNow();
    const topo = awareness._fields.topology as any;
    // Both nodes in knownNodes (all registry)
    expect(topo.knownNodes).toHaveLength(2);
    // But only connected in connectedRelays
    expect(topo.connectedRelays).toEqual(["relay-A"]);

    ts.destroy();
  });

  it("debounces node-change with 5s delay", () => {
    const registry = makeRegistry([makeNode("relay-A", ["relay"], true)]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    // Initial publish
    vi.advanceTimersByTime(2_000);
    awareness.setLocalStateField.mockClear();

    // Simulate node-registry change
    registry._fireChange();

    // Not yet at 2s — node debounce is 5s
    vi.advanceTimersByTime(2_000);
    expect(awareness.setLocalStateField).not.toHaveBeenCalled();

    // After 5s total
    vi.advanceTimersByTime(3_000);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(1);

    ts.destroy();
  });

  it("destroy cleans up timers and listeners", () => {
    const registry = makeRegistry();
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    ts.destroy();

    expect(libp2p._handlers.get("peer:connect")?.size ?? 0).toBe(0);
    expect(libp2p._handlers.get("peer:disconnect")?.size ?? 0).toBe(0);
    expect(registry._changeCbs.size).toBe(0);
  });
});
