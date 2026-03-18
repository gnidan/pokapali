/**
 * Tests for buildDiagnostics() — the diagnostics
 * builder that aggregates Helia, node registry,
 * awareness, and GossipSub state into a Diagnostics
 * snapshot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiagnosticsContext, Diagnostics } from "./doc-diagnostics.js";
import type { LoadingState } from "./facts.js";

// --- Module mocks ---

const mockGetPeers = vi.fn().mockReturnValue([]);
const mockGetConnections = vi.fn().mockReturnValue([]);
const mockGetTopics = vi.fn().mockReturnValue([]);
const mockGsPeers = vi.fn().mockReturnValue([]);

const mockGetMeshPeers = vi.fn().mockReturnValue([]);

vi.mock("./helia.js", () => ({
  isHeliaLive: vi.fn(() => true),
  getHelia: vi.fn(() => ({
    libp2p: {
      getPeers: mockGetPeers,
      getConnections: mockGetConnections,
      services: {
        pubsub: {
          getTopics: mockGetTopics,
          getPeers: mockGsPeers,
          getMeshPeers: mockGetMeshPeers,
        },
      },
    },
  })),
}));

const mockRegistryNodes = new Map<
  string,
  {
    peerId: string;
    connected: boolean;
    roles: string[];
    lastSeenAt: number;
    neighbors: Array<{
      peerId: string;
      role?: string;
    }>;
    browserCount?: number;
  }
>();

vi.mock("./node-registry.js", () => ({
  getNodeRegistry: vi.fn(() => ({
    nodes: mockRegistryNodes,
  })),
}));

// Import after mocks
const { buildDiagnostics } = await import("./doc-diagnostics.js");

// --- Helpers ---

function baseCtx(overrides?: Partial<DiagnosticsContext>): DiagnosticsContext {
  return {
    ackedBy: new Set<string>(),
    latestAnnouncedSeq: 0,
    loadingState: { status: "idle" } as LoadingState,
    hasAppliedSnapshot: false,
    guaranteeUntil: null,
    retainUntil: null,
    roomDiscovery: undefined,
    awareness: {
      getStates: () => new Map(),
    } as unknown as DiagnosticsContext["awareness"],
    clockSum: 0,
    ipnsSeq: null,
    ...overrides,
  };
}

// --- Tests ---

describe("buildDiagnostics", () => {
  beforeEach(() => {
    mockRegistryNodes.clear();
    mockGetPeers.mockReturnValue([]);
    mockGetConnections.mockReturnValue([]);
    mockGetTopics.mockReturnValue([]);
    mockGsPeers.mockReturnValue([]);
    mockGetMeshPeers.mockReturnValue([]);
  });

  it("passes through context fields", () => {
    const ctx = baseCtx({
      clockSum: 42,
      latestAnnouncedSeq: 7,
      ipnsSeq: 3,
      loadingState: {
        status: "fetching",
        cid: "baf123",
        startedAt: 1000,
      },
      hasAppliedSnapshot: true,
      guaranteeUntil: 5000,
      retainUntil: 10000,
    });

    const result = buildDiagnostics(ctx);

    expect(result.clockSum).toBe(42);
    expect(result.latestAnnouncedSeq).toBe(7);
    expect(result.ipnsSeq).toBe(3);
    expect(result.loadingState).toEqual({
      status: "fetching",
      cid: "baf123",
      startedAt: 1000,
    });
    expect(result.hasAppliedSnapshot).toBe(true);
    expect(result.guaranteeUntil).toBe(5000);
    expect(result.retainUntil).toBe(10000);
  });

  it("converts ackedBy set to array", () => {
    const ctx = baseCtx({
      ackedBy: new Set(["p1", "p2", "p3"]),
    });
    const result = buildDiagnostics(ctx);
    expect(result.ackedBy).toHaveLength(3);
    expect(result.ackedBy).toContain("p1");
    expect(result.ackedBy).toContain("p2");
    expect(result.ackedBy).toContain("p3");
  });

  it("builds node list from registry", () => {
    mockRegistryNodes.set("peer-relay", {
      peerId: "peer-relay",
      connected: true,
      roles: ["relay"],
      lastSeenAt: 1000,
      neighbors: [],
      browserCount: 2,
    });

    const result = buildDiagnostics(baseCtx());

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.peerId).toBe("peer-relay");
    expect(result.nodes[0]!.short).toBe("er-relay");
    expect(result.nodes[0]!.connected).toBe(true);
    expect(result.nodes[0]!.roles).toEqual(["relay"]);
    expect(result.nodes[0]!.rolesConfirmed).toBe(true);
    expect(result.nodes[0]!.ackedCurrentCid).toBe(false);
    expect(result.nodes[0]!.browserCount).toBe(2);
  });

  it("adds pinner role when peer acked but " + "roles lack it", () => {
    mockRegistryNodes.set("peer-acker", {
      peerId: "peer-acker",
      connected: true,
      roles: ["relay"],
      lastSeenAt: 500,
      neighbors: [],
    });

    const ctx = baseCtx({
      ackedBy: new Set(["peer-acker"]),
    });
    const result = buildDiagnostics(ctx);

    expect(result.nodes[0]!.roles).toContain("pinner");
    expect(result.nodes[0]!.roles).toContain("relay");
    expect(result.nodes[0]!.ackedCurrentCid).toBe(true);
  });

  it("does not duplicate pinner role when " + "already present", () => {
    mockRegistryNodes.set("peer-pinner", {
      peerId: "peer-pinner",
      connected: true,
      roles: ["relay", "pinner"],
      lastSeenAt: 500,
      neighbors: [],
    });

    const ctx = baseCtx({
      ackedBy: new Set(["peer-pinner"]),
    });
    const result = buildDiagnostics(ctx);

    const pinnerCount = result.nodes[0]!.roles.filter(
      (r: string) => r === "pinner",
    ).length;
    expect(pinnerCount).toBe(1);
  });

  it("merges DHT relays not in registry", () => {
    // Registry has peer-a
    mockRegistryNodes.set("peer-a", {
      peerId: "peer-a",
      connected: true,
      roles: ["relay"],
      lastSeenAt: 1000,
      neighbors: [],
    });

    // DHT discovered peer-b (not in registry)
    const ctx = baseCtx({
      roomDiscovery: {
        relayPeerIds: new Set(["peer-a", "peer-b"]),
      } as unknown as DiagnosticsContext["roomDiscovery"],
    });
    const result = buildDiagnostics(ctx);

    expect(result.nodes).toHaveLength(2);
    const peerB = result.nodes.find(
      (n: Diagnostics["nodes"][0]) => n.peerId === "peer-b",
    );
    expect(peerB).toBeDefined();
    expect(peerB!.roles).toEqual(["relay"]);
    expect(peerB!.rolesConfirmed).toBe(false);
    expect(peerB!.lastSeenAt).toBe(0);
  });

  it("DHT relay with ack gets pinner role", () => {
    const ctx = baseCtx({
      ackedBy: new Set(["dht-peer"]),
      roomDiscovery: {
        relayPeerIds: new Set(["dht-peer"]),
      } as unknown as DiagnosticsContext["roomDiscovery"],
    });
    const result = buildDiagnostics(ctx);

    const node = result.nodes[0]!;
    expect(node.roles).toContain("relay");
    expect(node.roles).toContain("pinner");
  });

  it("counts editors from awareness", () => {
    const states = new Map<number, unknown>();
    states.set(1, { clockSum: 10 });
    states.set(2, { clockSum: 20 });
    states.set(3, { clockSum: 5 });

    const ctx = baseCtx({
      awareness: {
        getStates: () => states,
      } as unknown as DiagnosticsContext["awareness"],
    });
    const result = buildDiagnostics(ctx);

    expect(result.editors).toBe(3);
    expect(result.maxPeerClockSum).toBe(20);
  });

  it("editors defaults to 1 when awareness " + "empty", () => {
    const result = buildDiagnostics(baseCtx());
    expect(result.editors).toBe(1);
    expect(result.maxPeerClockSum).toBe(0);
  });

  it("builds topology from neighbors", () => {
    mockRegistryNodes.set("relay-1", {
      peerId: "relay-1",
      connected: true,
      roles: ["relay"],
      lastSeenAt: 100,
      neighbors: [
        { peerId: "relay-2", role: "relay" },
        { peerId: "browser-1" },
      ],
    });
    mockRegistryNodes.set("relay-2", {
      peerId: "relay-2",
      connected: true,
      roles: ["relay"],
      lastSeenAt: 200,
      neighbors: [{ peerId: "relay-1", role: "relay" }],
    });

    const result = buildDiagnostics(baseCtx());

    expect(result.topology).toHaveLength(3);
    expect(result.topology).toContainEqual({
      source: "relay-1",
      target: "relay-2",
      targetRole: "relay",
    });
    expect(result.topology).toContainEqual({
      source: "relay-1",
      target: "browser-1",
    });
    expect(result.topology).toContainEqual({
      source: "relay-2",
      target: "relay-1",
      targetRole: "relay",
    });
  });

  it("reports ipfsPeers count", () => {
    mockGetPeers.mockReturnValue(["p1", "p2", "p3"]);
    const result = buildDiagnostics(baseCtx());
    expect(result.ipfsPeers).toBe(3);
  });

  it("reports gossipsub stats", () => {
    mockGetTopics.mockReturnValue(["t1", "t2"]);
    mockGsPeers.mockReturnValue(["p1"]);
    mockGetMeshPeers.mockReturnValue(["m1", "m2"]);

    const result = buildDiagnostics(baseCtx());
    expect(result.gossipsub.topics).toBe(2);
    expect(result.gossipsub.peers).toBe(1);
    // meshPeers = 2 per topic × 2 topics = 4
    expect(result.gossipsub.meshPeers).toBe(4);
  });
});
