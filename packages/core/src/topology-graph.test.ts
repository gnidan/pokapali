import { describe, it, expect } from "vitest";
import { buildTopologyGraph, nodeKind } from "./topology-graph.js";
import type {
  TopologyDiagnostics,
  TopologyAwareness,
} from "./topology-graph.js";

function makeAwareness(
  states: Map<number, Record<string, unknown>> = new Map(),
  clientID = 1,
): TopologyAwareness {
  return { getStates: () => states, clientID };
}

describe("nodeKind", () => {
  it("returns relay+pinner for both roles", () => {
    expect(nodeKind(["relay", "pinner"])).toBe("relay+pinner");
  });

  it("returns relay for relay only", () => {
    expect(nodeKind(["relay"])).toBe("relay");
  });

  it("returns pinner for pinner only", () => {
    expect(nodeKind(["pinner"])).toBe("pinner");
  });

  it("returns browser for no roles", () => {
    expect(nodeKind([])).toBe("browser");
  });
});

describe("buildTopologyGraph", () => {
  it("includes self node", () => {
    const info: TopologyDiagnostics = {
      nodes: [],
      topology: [],
    };
    const graph = buildTopologyGraph(info, makeAwareness());
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe("_self");
    expect(graph.nodes[0].kind).toBe("self");
  });

  it("adds infrastructure nodes from" + " diagnostics", () => {
    const info: TopologyDiagnostics = {
      nodes: [
        {
          peerId: "relay-A",
          short: "relay-A!",
          connected: true,
          roles: ["relay"],
          ackedCurrentCid: false,
          browserCount: undefined,
        },
      ],
      topology: [],
    };
    const graph = buildTopologyGraph(info, makeAwareness());
    expect(graph.nodes).toHaveLength(2);
    const relay = graph.nodes.find((n) => n.id === "relay-A")!;
    expect(relay.kind).toBe("relay");
    expect(relay.connected).toBe(true);

    // Edge from self to relay
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      source: "_self",
      target: "relay-A",
      connected: true,
    });
  });

  it("adds topology edges from neighbors", () => {
    const info: TopologyDiagnostics = {
      nodes: [
        {
          peerId: "relay-A",
          short: "relay-A!",
          connected: true,
          roles: ["relay"],
          ackedCurrentCid: false,
          browserCount: undefined,
        },
      ],
      topology: [
        {
          source: "relay-A",
          target: "relay-B",
          targetRole: "relay",
        },
      ],
    };
    const graph = buildTopologyGraph(info, makeAwareness());
    const topoEdge = graph.edges.find(
      (e) => e.source === "relay-A" && e.target === "relay-B",
    );
    expect(topoEdge).toBeDefined();
    expect(topoEdge!.connected).toBe(true);
  });

  it("merges knownNodes from awareness", () => {
    const info: TopologyDiagnostics = {
      nodes: [],
      topology: [],
    };
    const states = new Map<number, Record<string, unknown>>();
    states.set(1, {}); // self
    states.set(2, {
      topology: {
        connectedRelays: [],
        relayRoles: {},
        knownNodes: [
          {
            peerId: "relay-X",
            roles: ["relay", "pinner"],
            neighbors: [],
            browserCount: 5,
          },
        ],
      },
    });

    const graph = buildTopologyGraph(info, makeAwareness(states, 1));
    const relayX = graph.nodes.find((n) => n.id === "relay-X");
    expect(relayX).toBeDefined();
    expect(relayX!.kind).toBe("relay+pinner");
    expect(relayX!.browserCount).toBe(5);
  });

  it("adds browser peers from awareness", () => {
    const info: TopologyDiagnostics = {
      nodes: [],
      topology: [],
    };
    const states = new Map<number, Record<string, unknown>>();
    states.set(1, {}); // self
    states.set(42, {
      user: { name: "Alice" },
      topology: {
        connectedRelays: ["relay-A"],
        relayRoles: {
          "relay-A": ["relay"],
        },
      },
    });

    const graph = buildTopologyGraph(info, makeAwareness(states, 1));

    const browser = graph.nodes.find((n) => n.id === "awareness:42");
    expect(browser).toBeDefined();
    expect(browser!.kind).toBe("browser");
    expect(browser!.label).toBe("Alice");
    expect(browser!.clientId).toBe(42);

    // Relay node created from awareness
    const relay = graph.nodes.find((n) => n.id === "relay-A");
    expect(relay).toBeDefined();
    expect(relay!.kind).toBe("relay");

    // Browser→relay edge (no self→browser edge)
    const selfToBrowser = graph.edges.find(
      (e) => e.source === "_self" && e.target === "awareness:42",
    );
    expect(selfToBrowser).toBeUndefined();

    const browserToRelay = graph.edges.find(
      (e) => e.source === "awareness:42" && e.target === "relay-A",
    );
    expect(browserToRelay).toBeDefined();
  });

  it("deduplicates nodes by peerId", () => {
    const info: TopologyDiagnostics = {
      nodes: [
        {
          peerId: "relay-A",
          short: "relay-A!",
          connected: true,
          roles: ["relay"],
          ackedCurrentCid: false,
          browserCount: undefined,
        },
      ],
      topology: [],
    };
    const states = new Map<number, Record<string, unknown>>();
    states.set(1, {});
    states.set(2, {
      topology: {
        connectedRelays: ["relay-A"],
        relayRoles: {
          "relay-A": ["relay"],
        },
        knownNodes: [
          {
            peerId: "relay-A",
            roles: ["relay"],
            neighbors: [],
          },
        ],
      },
    });

    const graph = buildTopologyGraph(info, makeAwareness(states, 1));
    // relay-A should appear only once
    const relayNodes = graph.nodes.filter((n) => n.id === "relay-A");
    expect(relayNodes).toHaveLength(1);
  });
});
