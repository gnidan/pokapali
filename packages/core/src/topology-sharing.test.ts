import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  createTopologySharing,
} from "./topology-sharing.js";
import type { KnownNode } from "./node-registry.js";

function makeNode(
  peerId: string,
  roles: string[],
  connected: boolean,
): KnownNode {
  return {
    peerId,
    roles,
    lastSeenAt: Date.now(),
    connected,
    neighbors: [],
    browserCount: undefined,
  };
}

function makeRegistry(
  nodes: KnownNode[] = [],
) {
  const map = new Map<string, KnownNode>();
  for (const n of nodes) map.set(n.peerId, n);
  return {
    nodes: map as ReadonlyMap<string, KnownNode>,
    destroy: vi.fn(),
  };
}

function makeAwareness() {
  const fields: Record<string, unknown> = {};
  return {
    setLocalStateField: vi.fn(
      (key: string, val: unknown) => {
        fields[key] = val;
      },
    ),
    _fields: fields,
  };
}

function makeLibp2p() {
  const handlers = new Map<
    string,
    Set<(evt: any) => void>
  >();
  return {
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
    _dispatch(type: string, evt?: any) {
      for (const fn of
        handlers.get(type) ?? []
      ) {
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

  it("publishes connected relays after initial"
    + " delay", () => {
    const registry = makeRegistry([
      makeNode("relay-A", ["relay"], true),
      makeNode("relay-B", ["relay"], false),
      makeNode(
        "pinner-C", ["relay", "pinner"], true,
      ),
    ]);
    const awareness = makeAwareness();
    const libp2p = makeLibp2p();

    const ts = createTopologySharing({
      awareness: awareness as any,
      registry: registry as any,
      libp2p,
    });

    // Before initial delay — nothing published
    expect(
      awareness.setLocalStateField,
    ).not.toHaveBeenCalled();

    // After 2s initial delay
    vi.advanceTimersByTime(2_000);

    expect(
      awareness.setLocalStateField,
    ).toHaveBeenCalledWith(
      "topology",
      {
        connectedRelays: [
          "relay-A", "pinner-C",
        ],
        relayRoles: {
          "relay-A": ["relay"],
          "pinner-C": ["relay", "pinner"],
        },
      },
    );

    ts.destroy();
  });

  it("debounces peer connect events", () => {
    const registry = makeRegistry([
      makeNode("relay-A", ["relay"], true),
    ]);
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
    expect(
      awareness.setLocalStateField,
    ).not.toHaveBeenCalled();

    // After 2s debounce
    vi.advanceTimersByTime(2_000);
    expect(
      awareness.setLocalStateField,
    ).toHaveBeenCalledTimes(1);

    ts.destroy();
  });

  it("publishes periodically every 30s", () => {
    const registry = makeRegistry([
      makeNode("relay-A", ["relay"], true),
    ]);
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
    expect(
      awareness.setLocalStateField,
    ).toHaveBeenCalledTimes(1);

    ts.destroy();
  });

  it("publishNow forces immediate publish", () => {
    const registry = makeRegistry([
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
    expect(
      awareness.setLocalStateField,
    ).toHaveBeenCalledTimes(1);

    ts.destroy();
  });

  it("excludes non-relay non-pinner nodes", () => {
    const registry = makeRegistry([
      makeNode(
        "browser-X", ["browser"], true,
      ),
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
    expect(topo.connectedRelays).toEqual([
      "relay-A",
    ]);

    ts.destroy();
  });

  it("destroy cleans up timers and listeners",
    () => {
      const registry = makeRegistry();
      const awareness = makeAwareness();
      const libp2p = makeLibp2p();

      const ts = createTopologySharing({
        awareness: awareness as any,
        registry: registry as any,
        libp2p,
      });

      ts.destroy();

      expect(
        libp2p._handlers.get("peer:connect")
          ?.size ?? 0,
      ).toBe(0);
      expect(
        libp2p._handlers.get("peer:disconnect")
          ?.size ?? 0,
      ).toBe(0);
    },
  );
});
