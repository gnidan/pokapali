import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

vi.mock("./relay-cache.js", () => ({
  loadCachedRelays: vi.fn().mockReturnValue([]),
  upsertCachedRelay: vi.fn(),
}));

vi.mock("@pokapali/log", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  extractWssAddrs,
  startRoomDiscovery,
} from "./peer-discovery.js";
import {
  loadCachedRelays,
  upsertCachedRelay,
} from "./relay-cache.js";

const PID = "12D3KooWTestPeerId";

// --- Mock Helia factory ---

function makeMockHelia() {
  const listeners = new Map<
    string,
    Set<(...args: any[]) => void>
  >();
  return {
    libp2p: {
      dial: vi.fn().mockResolvedValue({}),
      getConnections: vi.fn().mockReturnValue([]),
      getPeers: vi.fn().mockReturnValue([]),
      getMultiaddrs: vi.fn().mockReturnValue([]),
      peerStore: {
        merge: vi.fn().mockResolvedValue(undefined),
      },
      addEventListener: vi.fn(
        (event: string, handler: any) => {
          if (!listeners.has(event)) {
            listeners.set(event, new Set());
          }
          listeners.get(event)!.add(handler);
        },
      ),
      removeEventListener: vi.fn(
        (event: string, handler: any) => {
          listeners.get(event)?.delete(handler);
        },
      ),
    },
    routing: {
      findProviders: vi.fn(async function* () {
        // empty by default
      }),
    },
    blockstore: { get: vi.fn() },
    _listeners: listeners,
    _emit(event: string, detail: any) {
      const handlers = listeners.get(event);
      if (!handlers) return;
      for (const h of handlers) {
        h(new CustomEvent(event, { detail }));
      }
    },
  };
}

type MockHelia = ReturnType<typeof makeMockHelia>;

// --- extractWssAddrs tests ---

describe("extractWssAddrs", () => {
  it("filters to /ws/ addresses", () => {
    const addrs = [
      "/ip4/1.2.3.4/tcp/4001/ws",
      "/ip4/1.2.3.4/tcp/4001",
      "/ip4/1.2.3.4/tcp/4001/ws/p2p/" + PID,
    ];
    const result = extractWssAddrs(
      PID, addrs, false,
    );
    expect(result).toHaveLength(2);
  });

  it("skips /p2p-circuit addrs", () => {
    const addrs = [
      "/ip4/1.2.3.4/tcp/4001/ws" +
        "/p2p-circuit/p2p/other",
    ];
    const result = extractWssAddrs(
      PID, addrs, false,
    );
    expect(result).toHaveLength(0);
  });

  it("in HTTPS context, skips plain ws", () => {
    const addrs = [
      "/ip4/1.2.3.4/tcp/4001/ws",
      "/ip4/1.2.3.4/tcp/443/tls/ws",
    ];
    const result = extractWssAddrs(
      PID, addrs, true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].toString()).toContain(
      "/tls/",
    );
  });

  it("appends /p2p/ suffix if missing", () => {
    const addrs = ["/ip4/1.2.3.4/tcp/4001/ws"];
    const result = extractWssAddrs(
      PID, addrs, false,
    );
    expect(result[0].toString()).toContain(
      `/p2p/${PID}`,
    );
  });

  it("preserves existing /p2p/ suffix", () => {
    const addr =
      "/ip4/1.2.3.4/tcp/4001/ws/p2p/" + PID;
    const result = extractWssAddrs(
      PID, [addr], false,
    );
    // Should not double the /p2p/ suffix
    const str = result[0].toString();
    const count =
      (str.match(/\/p2p\//g) || []).length;
    expect(count).toBe(1);
  });
});

// --- startRoomDiscovery tests ---

describe("startRoomDiscovery", () => {
  let helia: MockHelia;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    helia = makeMockHelia();
    // Reset to default (empty) — mockReturnValue
    // from prior tests persists through
    // clearAllMocks.
    vi.mocked(loadCachedRelays)
      .mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("stop() cleanup", () => {
    it("clears intervals (no more discovery " +
       "cycles after stop)", async () => {
      const rd = startRoomDiscovery(
        helia as any,
      );

      // Let initial async work settle
      await vi.advanceTimersByTimeAsync(1);

      const callsBefore =
        helia.routing.findProviders.mock.calls
          .length;

      rd.stop();

      // Advance past several discovery intervals
      await vi.advanceTimersByTimeAsync(120_000);

      // No new findProviders calls after stop
      expect(
        helia.routing.findProviders.mock.calls
          .length,
      ).toBe(callsBefore);
    });

    it("removes event listeners", () => {
      const rd = startRoomDiscovery(
        helia as any,
      );

      // Should have registered disconnect listener
      expect(
        helia.libp2p.addEventListener,
      ).toHaveBeenCalledWith(
        "peer:disconnect",
        expect.any(Function),
      );

      rd.stop();

      // Listener should be removed
      expect(
        helia.libp2p.removeEventListener,
      ).toHaveBeenCalledWith(
        "peer:disconnect",
        expect.any(Function),
      );

      // Internal listener set should be empty
      expect(
        helia._listeners.get("peer:disconnect")
          ?.size ?? 0,
      ).toBe(0);
    });

    it("aborts active discovery cycle", async () => {
      // Make findProviders block until aborted
      let abortSignal: AbortSignal | undefined;
      helia.routing.findProviders =
        vi.fn(async function* (
          _cid: any,
          opts?: { signal?: AbortSignal },
        ) {
          abortSignal = opts?.signal;
          // Yield nothing, just hang via a
          // promise that never resolves
          // (simulates slow DHT)
          await new Promise<void>((_, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => reject(
                new Error("aborted"),
              ),
            );
          });
        });

      const rd = startRoomDiscovery(
        helia as any,
      );

      // Let the discovery start (microtask)
      await vi.advanceTimersByTimeAsync(0);

      // Signal should exist but not be aborted
      expect(abortSignal).toBeDefined();
      expect(abortSignal!.aborted).toBe(false);

      rd.stop();

      // Signal should now be aborted
      expect(abortSignal!.aborted).toBe(true);
    });

    it("discoverRelays is no-op after stop",
      async () => {
      const rd = startRoomDiscovery(
        helia as any,
      );

      // Let initial cycle complete
      await vi.advanceTimersByTimeAsync(1);

      const callsBefore =
        helia.routing.findProviders.mock.calls
          .length;

      rd.stop();

      // Advance past a discovery interval
      await vi.advanceTimersByTimeAsync(30_000);

      expect(
        helia.routing.findProviders.mock.calls
          .length,
      ).toBe(callsBefore);
    });
  });

  describe("disconnect handler", () => {
    const RELAY_PID = "12D3KooWRelayPeer1234";
    const RELAY_ADDRS = [
      "/ip4/1.2.3.4/tcp/4001/ws",
    ];

    async function setupTrackedRelay(
      h: MockHelia,
    ) {
      const rd = startRoomDiscovery(h as any);
      await vi.advanceTimersByTimeAsync(1);

      // Add a relay via addExternalRelays
      // (dial will succeed via default mock)
      rd.addExternalRelays([{
        peerId: RELAY_PID,
        addrs: RELAY_ADDRS,
      }]);
      await vi.advanceTimersByTimeAsync(1);

      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(true);
      return rd;
    }

    it("keeps relay tracked during reconnect " +
       "and triggers redial after backoff",
      async () => {
      vi.mocked(loadCachedRelays)
        .mockReturnValue([{
          peerId: RELAY_PID,
          addrs: RELAY_ADDRS,
          lastSeen: Date.now(),
        }]);

      const rd = await setupTrackedRelay(helia);
      helia.libp2p.dial.mockClear();

      // Simulate disconnect
      helia._emit("peer:disconnect", {
        toString: () => RELAY_PID,
      });

      // Relay stays tracked during reconnect
      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(true);
      expect(rd.relayEntries().some(
        (e) => e.peerId === RELAY_PID,
      )).toBe(true);

      // No redial yet (backoff delay)
      await vi.advanceTimersByTimeAsync(1);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();

      // After 5s base delay, redial fires
      await vi.advanceTimersByTimeAsync(5_000);
      expect(helia.libp2p.dial)
        .toHaveBeenCalled();

      rd.stop();
    });

    it("skips non-relay peers", async () => {
      const rd = await setupTrackedRelay(helia);
      helia.libp2p.dial.mockClear();

      // Disconnect a peer that's not a relay
      helia._emit("peer:disconnect", {
        toString: () => "12D3KooWNotARelay",
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();

      rd.stop();
    });

    it("skips redial if stopped", async () => {
      vi.mocked(loadCachedRelays)
        .mockReturnValue([{
          peerId: RELAY_PID,
          addrs: RELAY_ADDRS,
          lastSeen: Date.now(),
        }]);

      const rd = await setupTrackedRelay(helia);
      helia.libp2p.dial.mockClear();

      rd.stop();

      // Disconnect after stop — timer should
      // not be scheduled
      helia._emit("peer:disconnect", {
        toString: () => RELAY_PID,
      });

      // Advance past all backoff delays
      await vi.advanceTimersByTimeAsync(60_000);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();
    });

    it("skips redial if no cache entry",
      async () => {
      // loadCachedRelays returns empty
      vi.mocked(loadCachedRelays)
        .mockReturnValue([]);

      const rd = await setupTrackedRelay(helia);
      helia.libp2p.dial.mockClear();

      helia._emit("peer:disconnect", {
        toString: () => RELAY_PID,
      });

      // Advance past backoff delay
      await vi.advanceTimersByTimeAsync(6_000);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();

      rd.stop();
    });

    it("uses exponential backoff delay",
      async () => {
      vi.mocked(loadCachedRelays)
        .mockReturnValue([{
          peerId: RELAY_PID,
          addrs: RELAY_ADDRS,
          lastSeen: Date.now(),
        }]);

      const rd = await setupTrackedRelay(helia);
      helia.libp2p.dial.mockClear();

      // First disconnect: redial with 5s delay
      helia.libp2p.dial.mockRejectedValue(
        new Error("refused"),
      );
      helia._emit("peer:disconnect", {
        toString: () => RELAY_PID,
      });

      // Not yet at 4s
      await vi.advanceTimersByTimeAsync(4_000);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();

      // Fires at 5s
      await vi.advanceTimersByTimeAsync(1_001);
      expect(helia.libp2p.dial)
        .toHaveBeenCalledTimes(1);

      // Let the failed dial settle. Relay stays
      // tracked (no re-add needed).
      await vi.advanceTimersByTimeAsync(1);
      helia.libp2p.dial.mockClear();

      // Second disconnect: 10s delay (5s * 2^1)
      helia.libp2p.dial.mockRejectedValue(
        new Error("refused"),
      );
      helia._emit("peer:disconnect", {
        toString: () => RELAY_PID,
      });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(helia.libp2p.dial)
        .toHaveBeenCalledTimes(1);

      rd.stop();
    });

    it("stops retrying after max attempts " +
       "and untracks relay", async () => {
      vi.mocked(loadCachedRelays)
        .mockReturnValue([{
          peerId: RELAY_PID,
          addrs: RELAY_ADDRS,
          lastSeen: Date.now(),
        }]);

      const rd = await setupTrackedRelay(helia);
      helia.libp2p.dial.mockClear();
      helia.libp2p.dial.mockRejectedValue(
        new Error("refused"),
      );

      // Simulate 8 disconnect+fail cycles
      for (let i = 0; i < 8; i++) {
        helia.libp2p.dial.mockClear();
        helia._emit("peer:disconnect", {
          toString: () => RELAY_PID,
        });

        // Relay stays tracked during window
        expect(rd.relayPeerIds.has(RELAY_PID))
          .toBe(true);

        const delay = 5_000 * Math.pow(2, i);
        await vi.advanceTimersByTimeAsync(
          delay + 1,
        );
        expect(helia.libp2p.dial)
          .toHaveBeenCalledTimes(1);

        // Let failed dial settle
        await vi.advanceTimersByTimeAsync(1);
      }

      // 9th disconnect: max attempts reached,
      // relay untracked, no redial scheduled
      helia.libp2p.dial.mockClear();
      helia._emit("peer:disconnect", {
        toString: () => RELAY_PID,
      });

      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(false);

      await vi.advanceTimersByTimeAsync(
        5_000 * Math.pow(2, 8) + 1,
      );
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();

      rd.stop();
    });

    it("tags relay peer in peerStore on track",
      async () => {
      const remotePeer = {
        toString: () => RELAY_PID,
      };
      helia.libp2p.getConnections
        .mockReturnValue([{ remotePeer }]);

      const rd = await setupTrackedRelay(helia);

      expect(helia.libp2p.peerStore.merge)
        .toHaveBeenCalledWith(
          remotePeer,
          {
            tags: {
              "pokapali-relay": { value: 100 },
            },
          },
        );

      rd.stop();
    });
  });

  describe("dialRelay (via addExternalRelays)", () => {
    const RELAY_PID = "12D3KooWDialTest1234";
    const RELAY_ADDRS = [
      "/ip4/1.2.3.4/tcp/4001/ws",
    ];

    it("successful dial tracks relay",
      async () => {
      helia.libp2p.dial
        .mockResolvedValue({});

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);

      rd.addExternalRelays([{
        peerId: RELAY_PID,
        addrs: RELAY_ADDRS,
      }]);
      await vi.advanceTimersByTimeAsync(1);

      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(true);
      expect(rd.relayEntries()).toContainEqual(
        expect.objectContaining({
          peerId: RELAY_PID,
        }),
      );
      expect(upsertCachedRelay)
        .toHaveBeenCalledWith(
          RELAY_PID, RELAY_ADDRS,
        );

      rd.stop();
    });

    it("dial timeout returns false " +
       "(relay not tracked)", async () => {
      // Make dial hang forever
      helia.libp2p.dial.mockImplementation(
        () => new Promise(() => {}),
      );

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);

      rd.addExternalRelays([{
        peerId: RELAY_PID,
        addrs: RELAY_ADDRS,
      }]);

      // Advance past DIAL_TIMEOUT_MS (10s)
      await vi.advanceTimersByTimeAsync(11_000);

      // Relay should NOT be tracked (dial
      // timed out and was aborted)
      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(false);

      rd.stop();
    });

    it("dial failure returns false",
      async () => {
      helia.libp2p.dial.mockRejectedValue(
        new Error("connection refused"),
      );

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);

      rd.addExternalRelays([{
        peerId: RELAY_PID,
        addrs: RELAY_ADDRS,
      }]);
      await vi.advanceTimersByTimeAsync(1);

      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(false);

      rd.stop();
    });

    it("empty wss addrs skips dial",
      async () => {
      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);
      helia.libp2p.dial.mockClear();

      // Provide addrs with no /ws in them
      rd.addExternalRelays([{
        peerId: RELAY_PID,
        addrs: ["/ip4/1.2.3.4/tcp/4001"],
      }]);
      await vi.advanceTimersByTimeAsync(1);

      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();
      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(false);

      rd.stop();
    });

    it("skips already-connected relays",
      async () => {
      helia.libp2p.getConnections
        .mockReturnValue([{
          remotePeer: {
            toString: () => RELAY_PID,
          },
        }]);

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);
      helia.libp2p.dial.mockClear();

      rd.addExternalRelays([{
        peerId: RELAY_PID,
        addrs: RELAY_ADDRS,
      }]);
      await vi.advanceTimersByTimeAsync(1);

      // Should track without dialing
      expect(rd.relayPeerIds.has(RELAY_PID))
        .toBe(true);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();

      rd.stop();
    });
  });

  describe("discoverRelays", () => {
    const PROVIDER_PID = "12D3KooWProvider1234";
    const PROVIDER_ADDRS = [
      "/ip4/5.6.7.8/tcp/4001/ws",
    ];

    function makeProvider(
      pid: string,
      addrs: string[],
    ) {
      return {
        id: { toString: () => pid },
        multiaddrs: addrs.map(
          (a) => ({ toString: () => a }),
        ),
      };
    }

    it("finds and dials DHT provider",
      async () => {
      helia.routing.findProviders =
        vi.fn(async function* () {
          yield makeProvider(
            PROVIDER_PID,
            PROVIDER_ADDRS,
          );
        });

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);

      expect(rd.relayPeerIds.has(PROVIDER_PID))
        .toBe(true);
      expect(helia.libp2p.dial)
        .toHaveBeenCalled();
      expect(upsertCachedRelay)
        .toHaveBeenCalledWith(
          PROVIDER_PID,
          PROVIDER_ADDRS,
        );

      rd.stop();
    });

    it("skips already-connected provider",
      async () => {
      helia.libp2p.getConnections
        .mockReturnValue([{
          remotePeer: {
            toString: () => PROVIDER_PID,
          },
        }]);

      helia.routing.findProviders =
        vi.fn(async function* () {
          yield makeProvider(
            PROVIDER_PID,
            PROVIDER_ADDRS,
          );
        });

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);

      // Should track without dialing
      expect(rd.relayPeerIds.has(PROVIDER_PID))
        .toBe(true);
      expect(helia.libp2p.dial)
        .not.toHaveBeenCalled();

      rd.stop();
    });

    it("skips provider with no browser-dialable " +
       "addrs", async () => {
      helia.routing.findProviders =
        vi.fn(async function* () {
          yield makeProvider(PROVIDER_PID, [
            "/ip4/1.2.3.4/tcp/4001",
            "/ip4/1.2.3.4/udp/4001/quic",
          ]);
        });

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(1);

      expect(rd.relayPeerIds.has(PROVIDER_PID))
        .toBe(false);

      rd.stop();
    });

    it("aborts after FIND_TIMEOUT_MS",
      async () => {
      let abortSignal: AbortSignal | undefined;
      helia.routing.findProviders =
        vi.fn(async function* (
          _cid: any,
          opts?: { signal?: AbortSignal },
        ) {
          abortSignal = opts?.signal;
          await new Promise<void>((_, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => reject(
                new Error("aborted"),
              ),
            );
          });
        });

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(abortSignal).toBeDefined();
      expect(abortSignal!.aborted).toBe(false);

      // Advance past FIND_TIMEOUT_MS (30s)
      await vi.advanceTimersByTimeAsync(31_000);

      expect(abortSignal!.aborted).toBe(true);

      rd.stop();
    });

    it("re-entrance guard prevents " +
       "concurrent cycles", async () => {
      // Track how many times findProviders
      // is entered.
      let firstCallResolve: () => void =
        () => {};
      let callCount = 0;
      helia.routing.findProviders =
        vi.fn(async function* () {
          callCount++;
          if (callCount === 1) {
            // Block until we resolve manually
            await new Promise<void>((resolve) => {
              firstCallResolve = resolve;
            });
          }
        });

      const rd = startRoomDiscovery(
        helia as any,
      );
      await vi.advanceTimersByTimeAsync(0);

      // First cycle is running (blocked)
      expect(callCount).toBe(1);

      // Advance 10s (within FIND_TIMEOUT_MS)
      // and trigger what would be an interval
      // if it fired
      await vi.advanceTimersByTimeAsync(10_000);

      // Still 1 — running flag blocks re-entry
      expect(callCount).toBe(1);

      // Let first cycle finish
      firstCallResolve();
      await vi.advanceTimersByTimeAsync(0);

      // Now both the second startup discovery (15s)
      // and first interval (30s) can run
      await vi.advanceTimersByTimeAsync(20_000);
      expect(callCount).toBe(3);

      rd.stop();
    });

    it("handles findProviders errors " +
       "gracefully", async () => {
      helia.routing.findProviders =
        vi.fn(async function* () {
          throw new Error("network failure");
        });

      const rd = startRoomDiscovery(
        helia as any,
      );

      // Should not throw
      await vi.advanceTimersByTimeAsync(1);

      // Discovery should recover: next cycle
      // can run (running flag reset)
      helia.routing.findProviders =
        vi.fn(async function* () {
          yield makeProvider(
            PROVIDER_PID,
            PROVIDER_ADDRS,
          );
        });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(rd.relayPeerIds.has(PROVIDER_PID))
        .toBe(true);

      rd.stop();
    });
  });
});
