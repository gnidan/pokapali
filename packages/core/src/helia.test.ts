import {
  describe, it, expect, vi, beforeEach,
} from "vitest";

const {
  mockPubsub,
  mockStop,
  mockHelia,
  mockCreateHelia,
  mockGossipsub,
} = vi.hoisted(() => {
  const mockPubsub = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
  };

  const mockStop =
    vi.fn().mockResolvedValue(undefined);

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

  const mockCreateHelia =
    vi.fn().mockResolvedValue(mockHelia);
  const mockGossipsub =
    vi.fn().mockReturnValue("gossipsub-service");

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

import {
  acquireHelia,
  releaseHelia,
  getHeliaPubsub,
  _resetHeliaState,
} from "./helia.js";

describe("helia lifecycle", () => {
  beforeEach(() => {
    _resetHeliaState();
    mockStop.mockClear();
    mockCreateHelia.mockClear();
    mockCreateHelia.mockResolvedValue(mockHelia);
  });

  it(
    "acquireHelia() returns a Helia instance",
    async () => {
      const helia = await acquireHelia();
      expect(helia).toBe(mockHelia);
    },
  );

  it(
    "second acquireHelia() returns same instance",
    async () => {
      const first = await acquireHelia();
      const second = await acquireHelia();
      expect(first).toBe(second);
      expect(
        mockCreateHelia
      ).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "releaseHelia() decrements refcount",
    async () => {
      await acquireHelia();
      await acquireHelia();
      await releaseHelia();
      expect(mockStop).not.toHaveBeenCalled();
    },
  );

  it(
    "after all releases, Helia is stopped",
    async () => {
      await acquireHelia();
      await acquireHelia();
      await releaseHelia();
      await releaseHelia();
      expect(mockStop).toHaveBeenCalledOnce();
    },
  );

  it(
    "getHeliaPubsub() returns pubsub service",
    async () => {
      await acquireHelia();
      const pubsub = getHeliaPubsub();
      expect(pubsub).toBe(mockPubsub);
    },
  );

  it(
    "getHeliaPubsub() throws with no Helia",
    () => {
      expect(() => getHeliaPubsub()).toThrow(
        "No Helia instance exists"
      );
    },
  );

  it(
    "passes gossipsub in libp2p services",
    async () => {
      await acquireHelia();
      const call = mockCreateHelia.mock.calls[0];
      const init = call[0] as Record<
        string, unknown
      >;
      const libp2p = init.libp2p as Record<
        string, unknown
      >;
      const services = libp2p.services as Record<
        string, unknown
      >;
      expect(services.pubsub).toBe(
        "gossipsub-service"
      );
    },
  );

  it(
    "releaseHelia() is no-op with no instance",
    async () => {
      await releaseHelia();
      expect(mockStop).not.toHaveBeenCalled();
    },
  );

  it(
    "can re-acquire after full release",
    async () => {
      await acquireHelia();
      await releaseHelia();
      expect(mockStop).toHaveBeenCalledOnce();

      mockStop.mockClear();
      const helia = await acquireHelia();
      expect(helia).toBe(mockHelia);
      expect(
        mockCreateHelia
      ).toHaveBeenCalledTimes(2);
    },
  );
});
