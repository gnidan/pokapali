import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPubsub, mockStop, mockHelia, mockCreateHelia, mockGossipsub } =
  vi.hoisted(() => {
    const mockPubsub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      publish: vi.fn(),
    };

    const mockStop = vi.fn().mockResolvedValue(undefined);

    const mockHelia = {
      libp2p: {
        services: { pubsub: mockPubsub },
      },
      stop: mockStop,
      start: vi.fn(),
      blockstore: {},
      datastore: {},
      pins: {},
      logger: {},
      routing: {},
      dns: {},
      gc: vi.fn(),
      getCodec: vi.fn(),
      getHasher: vi.fn(),
    };

    const mockCreateHelia = vi.fn().mockResolvedValue(mockHelia);
    const mockGossipsub = vi.fn().mockReturnValue("gossipsub-service");

    return {
      mockPubsub,
      mockStop,
      mockHelia,
      mockCreateHelia,
      mockGossipsub,
    };
  });

vi.mock("helia", () => ({
  createHelia: mockCreateHelia,
  libp2pDefaults: vi.fn().mockReturnValue({
    services: {},
  }),
}));

vi.mock("@chainsafe/libp2p-gossipsub", () => ({
  gossipsub: mockGossipsub,
}));

describe("helia lifecycle", () => {
  let mod: typeof import("./helia.js");

  beforeEach(async () => {
    vi.resetModules();
    mockStop.mockReset().mockResolvedValue(undefined);
    mockCreateHelia.mockClear();
    mockCreateHelia.mockResolvedValue(mockHelia);
    mod = await import("./helia.js");
  });

  it("acquireHelia() returns a Helia instance", async () => {
    const helia = await mod.acquireHelia();
    expect(helia).toBe(mockHelia);
  });

  it("second acquireHelia() returns same instance", async () => {
    const first = await mod.acquireHelia();
    const second = await mod.acquireHelia();
    expect(first).toBe(second);
    expect(mockCreateHelia).toHaveBeenCalledTimes(1);
  });

  it("releaseHelia() decrements refcount", async () => {
    await mod.acquireHelia();
    await mod.acquireHelia();
    await mod.releaseHelia();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("after all releases, Helia is stopped", async () => {
    await mod.acquireHelia();
    await mod.acquireHelia();
    await mod.releaseHelia();
    await mod.releaseHelia();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("getHeliaPubsub() returns pubsub service", async () => {
    await mod.acquireHelia();
    const pubsub = mod.getHeliaPubsub();
    expect(pubsub).toBe(mockPubsub);
  });

  it("getHeliaPubsub() throws with no Helia", () => {
    expect(() => mod.getHeliaPubsub()).toThrow("No Helia instance exists");
  });

  it("passes gossipsub in libp2p services", async () => {
    await mod.acquireHelia();
    const call = mockCreateHelia.mock.calls[0]!;
    const init = call[0] as Record<string, unknown>;
    const libp2p = init.libp2p as Record<string, unknown>;
    const services = libp2p.services as Record<string, unknown>;
    expect(services.pubsub).toBe("gossipsub-service");
  });

  it("releaseHelia() is no-op with no instance", async () => {
    await mod.releaseHelia();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("can re-acquire after full release", async () => {
    await mod.acquireHelia();
    await mod.releaseHelia();
    expect(mockStop).toHaveBeenCalledOnce();

    mockStop.mockClear();
    const helia = await mod.acquireHelia();
    expect(helia).toBe(mockHelia);
    expect(mockCreateHelia).toHaveBeenCalledTimes(2);
  });

  it(
    "concurrent acquireHelia() calls share one " + "createHelia (#106)",
    async () => {
      // Make createHelia slow so both calls overlap.
      let resolveCreate!: (v: unknown) => void;
      mockCreateHelia.mockReturnValue(
        new Promise((r) => {
          resolveCreate = r;
        }),
      );

      const p1 = mod.acquireHelia();
      const p2 = mod.acquireHelia();

      resolveCreate(mockHelia);
      const [h1, h2] = await Promise.all([p1, p2]);

      expect(h1).toBe(mockHelia);
      expect(h2).toBe(mockHelia);
      expect(mockCreateHelia).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "releaseHelia() during bootstrap defers " + "destruction (#107)",
    async () => {
      let resolveCreate!: (v: unknown) => void;
      mockCreateHelia.mockReturnValue(
        new Promise((r) => {
          resolveCreate = r;
        }),
      );

      const p = mod.acquireHelia();

      // Release while createHelia is still pending.
      await mod.releaseHelia();

      resolveCreate(mockHelia);
      await expect(p).rejects.toThrow("released while still bootstrapping");
      expect(mockStop).toHaveBeenCalledOnce();
    },
  );

  it(
    "concurrent acquire + bootstrap release " +
      "rejects all waiters (#106 + #107)",
    async () => {
      let resolveCreate!: (v: unknown) => void;
      mockCreateHelia.mockReturnValue(
        new Promise((r) => {
          resolveCreate = r;
        }),
      );

      const p1 = mod.acquireHelia();
      const p2 = mod.acquireHelia();

      await mod.releaseHelia();
      resolveCreate(mockHelia);

      await expect(p1).rejects.toThrow("released while still bootstrapping");
      await expect(p2).rejects.toThrow("released while still bootstrapping");
    },
  );

  it("ref count: acquire x3, release x2 does not stop", async () => {
    await mod.acquireHelia();
    await mod.acquireHelia();
    await mod.acquireHelia();
    await mod.releaseHelia();
    await mod.releaseHelia();
    expect(mockStop).not.toHaveBeenCalled();

    // Third release stops
    await mod.releaseHelia();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("multiple releases beyond refcount are no-ops", async () => {
    await mod.acquireHelia();
    await mod.releaseHelia();
    expect(mockStop).toHaveBeenCalledOnce();

    mockStop.mockClear();
    await mod.releaseHelia();
    await mod.releaseHelia();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it(
    "acquire during destroy waits for stop " + "before creating new instance",
    async () => {
      await mod.acquireHelia();

      // Make stop() slow so acquire overlaps.
      let resolveStop!: () => void;
      mockStop.mockReturnValue(
        new Promise<void>((r) => {
          resolveStop = r;
        }),
      );

      // Start releasing (triggers stop)
      const releaseP = mod.releaseHelia();

      // Acquire while stop() is in-flight
      const acquireP = mod.acquireHelia();

      // stop() hasn't finished — createHelia should
      // NOT have been called again yet
      expect(mockCreateHelia).toHaveBeenCalledTimes(1);

      // Finish stop()
      resolveStop();
      await releaseP;

      // Now acquireHelia should create a fresh instance
      const h = await acquireP;
      expect(h).toBe(mockHelia);
      expect(mockCreateHelia).toHaveBeenCalledTimes(2);
    },
  );

  it(
    "concurrent acquire during bootstrap shares " + "refcount correctly",
    async () => {
      let resolveCreate!: (v: unknown) => void;
      mockCreateHelia.mockReturnValue(
        new Promise((r) => {
          resolveCreate = r;
        }),
      );

      const p1 = mod.acquireHelia();
      const p2 = mod.acquireHelia();
      const p3 = mod.acquireHelia();

      resolveCreate(mockHelia);
      await Promise.all([p1, p2, p3]);

      // 3 acquires → need 3 releases to stop
      await mod.releaseHelia();
      await mod.releaseHelia();
      expect(mockStop).not.toHaveBeenCalled();

      await mod.releaseHelia();
      expect(mockStop).toHaveBeenCalledOnce();
    },
  );

  it("acquire after deferred-destroy creates fresh instance", async () => {
    let resolveCreate!: (v: unknown) => void;
    mockCreateHelia.mockReturnValue(
      new Promise((r) => {
        resolveCreate = r;
      }),
    );

    const p1 = mod.acquireHelia();
    await mod.releaseHelia(); // deferred
    resolveCreate(mockHelia);
    await expect(p1).rejects.toThrow("released while still bootstrapping");

    // State should be fully reset — new acquire
    // creates a fresh instance
    mockCreateHelia.mockResolvedValue(mockHelia);
    const h = await mod.acquireHelia();
    expect(h).toBe(mockHelia);
    expect(mockCreateHelia).toHaveBeenCalledTimes(2);
  });

  it("createHelia error resets state cleanly", async () => {
    mockCreateHelia.mockRejectedValueOnce(new Error("bootstrap failed"));

    await expect(mod.acquireHelia()).rejects.toThrow("bootstrap failed");

    // State should be clean — next acquire works
    mockCreateHelia.mockResolvedValue(mockHelia);
    const h = await mod.acquireHelia();
    expect(h).toBe(mockHelia);
  });

  it("concurrent acquires see createHelia error", async () => {
    let rejectCreate!: (e: Error) => void;
    mockCreateHelia.mockReturnValue(
      new Promise((_, rej) => {
        rejectCreate = rej;
      }),
    );

    const p1 = mod.acquireHelia();
    const p2 = mod.acquireHelia();

    rejectCreate(new Error("network down"));

    await expect(p1).rejects.toThrow("network down");
    await expect(p2).rejects.toThrow("network down");
    expect(mockCreateHelia).toHaveBeenCalledTimes(1);

    // State should be clean after error
    mockCreateHelia.mockResolvedValue(mockHelia);
    const h = await mod.acquireHelia();
    expect(h).toBe(mockHelia);
  });
});
