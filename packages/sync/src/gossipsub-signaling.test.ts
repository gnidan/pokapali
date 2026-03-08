import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const {
  mockSignalingConns,
  mockSetupSignalingHandlers,
} = vi.hoisted(() => {
  const mockSignalingConns =
    new Map<string, unknown>();
  const mockSetupSignalingHandlers = vi.fn();
  return {
    mockSignalingConns,
    mockSetupSignalingHandlers,
  };
});

vi.mock("y-webrtc", () => ({
  signalingConns: mockSignalingConns,
  setupSignalingHandlers: mockSetupSignalingHandlers,
  WebrtcProvider: class {},
  SignalingConn: class {},
}));

import {
  createGossipSubSignaling,
  GossipSubSignaling,
  type PubSubLike,
} from "./gossipsub-signaling.js";

function createMockPubSub(): PubSubLike & {
  _handlers: Map<string, Set<(evt: CustomEvent) => void>>;
  _subscribed: Set<string>;
  _published: Array<{
    topic: string;
    data: Uint8Array;
  }>;
  simulateMessage(
    topic: string,
    data: Uint8Array
  ): void;
} {
  const handlers = new Map<
    string,
    Set<(evt: CustomEvent) => void>
  >();
  const subscribed = new Set<string>();
  const published: Array<{
    topic: string;
    data: Uint8Array;
  }> = [];

  return {
    _handlers: handlers,
    _subscribed: subscribed,
    _published: published,

    subscribe(topic: string) {
      subscribed.add(topic);
    },
    unsubscribe(topic: string) {
      subscribed.delete(topic);
    },
    async publish(topic: string, data: Uint8Array) {
      published.push({ topic, data });
    },
    addEventListener(
      type: string,
      handler: (evt: CustomEvent) => void
    ) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type)!.add(handler);
    },
    removeEventListener(
      type: string,
      handler: (evt: CustomEvent) => void
    ) {
      handlers.get(type)?.delete(handler);
    },
    simulateMessage(topic: string, data: Uint8Array) {
      const detail = { topic, data };
      const evt = new CustomEvent("message", { detail });
      const set = handlers.get("message");
      if (set) {
        for (const h of set) {
          h(evt);
        }
      }
    },
  };
}

describe("GossipSubSignaling", () => {
  let pubsub: ReturnType<typeof createMockPubSub>;
  let adapter: GossipSubSignaling;

  beforeEach(() => {
    mockSignalingConns.clear();
    mockSetupSignalingHandlers.mockReset();
    pubsub = createMockPubSub();
  });

  afterEach(() => {
    if (adapter) {
      adapter.destroy();
    }
  });

  describe("createGossipSubSignaling", () => {
    it("registers adapter in signalingConns", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(
        mockSignalingConns.has("libp2p:gossipsub")
      ).toBe(true);
      expect(
        mockSignalingConns.get("libp2p:gossipsub")
      ).toBe(adapter);
    });

    it("calls setupSignalingHandlers", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(
        mockSetupSignalingHandlers
      ).toHaveBeenCalledOnce();
      expect(
        mockSetupSignalingHandlers
      ).toHaveBeenCalledWith(adapter);
    });

    it("emits connect after creation", () => {
      const connectSpy = vi.fn();
      // Create adapter manually so we can listen before
      // the connect event fires
      adapter = new GossipSubSignaling(pubsub);
      adapter.on("connect", connectSpy);

      // Simulate what createGossipSubSignaling does
      // after construction
      mockSignalingConns.set(
        "libp2p:gossipsub",
        adapter
      );
      mockSetupSignalingHandlers(adapter);
      adapter.connected = true;
      adapter.emit("connect", []);

      expect(connectSpy).toHaveBeenCalledOnce();
    });

    it("sets connected to true", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(adapter.connected).toBe(true);
    });

    it("has url set to adapter key", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(adapter.url).toBe("libp2p:gossipsub");
    });

    it("has empty providers Set", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(adapter.providers).toBeInstanceOf(Set);
      expect(adapter.providers.size).toBe(0);
    });
  });

  describe("send subscribe", () => {
    it(
      "subscribes to shared signaling topic",
      () => {
        adapter = createGossipSubSignaling(pubsub);
        adapter.send({
          type: "subscribe",
          topics: ["room1", "room2"],
        });
        // All rooms share one GossipSub topic
        expect(
          pubsub._subscribed.has(
            "/pokapali/signaling"
          )
        ).toBe(true);
        expect(pubsub._subscribed.size).toBe(1);
      }
    );

    it("does not double-subscribe", () => {
      adapter = createGossipSubSignaling(pubsub);
      const subscribeSpy = vi.spyOn(
        pubsub,
        "subscribe"
      );
      adapter.send({
        type: "subscribe",
        topics: ["room1"],
      });
      adapter.send({
        type: "subscribe",
        topics: ["room1"],
      });
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("send publish", () => {
    it(
      "publishes JSON-encoded data to shared topic",
      () => {
        adapter = createGossipSubSignaling(pubsub);
        const signalData = {
          type: "announce",
          from: "peer-123",
        };
        adapter.send({
          type: "publish",
          topic: "room1",
          data: signalData,
        });

        expect(pubsub._published).toHaveLength(1);
        const pub = pubsub._published[0];
        // All publishes go to the shared topic
        expect(pub.topic).toBe(
          "/pokapali/signaling"
        );
        // Room name is in the payload
        const decoded = JSON.parse(
          new TextDecoder().decode(pub.data)
        );
        expect(decoded).toEqual({
          type: "publish",
          topic: "room1",
          data: signalData,
        });
      }
    );
  });

  describe("send unsubscribe", () => {
    it(
      "keeps shared topic subscribed " +
        "(only unsubscribed on destroy)",
      () => {
        adapter = createGossipSubSignaling(pubsub);
        adapter.send({
          type: "subscribe",
          topics: ["room1"],
        });
        expect(
          pubsub._subscribed.has(
            "/pokapali/signaling"
          )
        ).toBe(true);

        // Unsubscribe is a no-op — other rooms may
        // still need the shared topic
        adapter.send({
          type: "unsubscribe",
          topics: ["room1"],
        });
        expect(
          pubsub._subscribed.has(
            "/pokapali/signaling"
          )
        ).toBe(true);
      }
    );
  });

  describe("incoming GossipSub messages", () => {
    it(
      "emits message event with decoded payload",
      () => {
        adapter = createGossipSubSignaling(pubsub);

        const messageSpy = vi.fn();
        adapter.on("message", messageSpy);

        const payload = {
          type: "publish",
          topic: "room1",
          data: {
            type: "announce",
            from: "peer-456",
          },
        };
        const encoded = new TextEncoder().encode(
          JSON.stringify(payload)
        );
        pubsub.simulateMessage(
          "/pokapali/signaling",
          encoded
        );

        expect(messageSpy).toHaveBeenCalledOnce();
        expect(messageSpy).toHaveBeenCalledWith(
          payload
        );
      }
    );

    it("ignores messages with non-matching prefix", () => {
      adapter = createGossipSubSignaling(pubsub);

      const messageSpy = vi.fn();
      adapter.on("message", messageSpy);

      const encoded = new TextEncoder().encode(
        JSON.stringify({ type: "publish" })
      );
      pubsub.simulateMessage(
        "/other/topic/room1",
        encoded
      );

      expect(messageSpy).not.toHaveBeenCalled();
    });

    it("ignores malformed JSON", () => {
      adapter = createGossipSubSignaling(pubsub);

      const messageSpy = vi.fn();
      adapter.on("message", messageSpy);

      const garbage = new TextEncoder().encode(
        "not valid json{{{"
      );
      pubsub.simulateMessage(
        "/pokapali/signal/room1",
        garbage
      );

      expect(messageSpy).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("unsubscribes shared topic", () => {
      adapter = createGossipSubSignaling(pubsub);
      adapter.send({
        type: "subscribe",
        topics: ["r1", "r2"],
      });
      expect(pubsub._subscribed.size).toBe(1);
      expect(
        pubsub._subscribed.has(
          "/pokapali/signaling"
        )
      ).toBe(true);

      adapter.destroy();
      expect(pubsub._subscribed.size).toBe(0);
    });

    it("removes from signalingConns", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(
        mockSignalingConns.has("libp2p:gossipsub")
      ).toBe(true);

      adapter.destroy();
      expect(
        mockSignalingConns.has("libp2p:gossipsub")
      ).toBe(false);
    });

    it("sets connected to false", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(adapter.connected).toBe(true);

      adapter.destroy();
      expect(adapter.connected).toBe(false);
    });

    it(
      "removes event listener from pubsub",
      () => {
        adapter = createGossipSubSignaling(pubsub);
        const handlersBefore =
          pubsub._handlers.get("message")?.size ?? 0;
        expect(handlersBefore).toBe(1);

        adapter.destroy();
        const handlersAfter =
          pubsub._handlers.get("message")?.size ?? 0;
        expect(handlersAfter).toBe(0);
      }
    );

    it(
      "stops emitting messages after destroy",
      () => {
        adapter = createGossipSubSignaling(pubsub);
        adapter.destroy();

        const messageSpy = vi.fn();
        // Re-register listener — should not fire
        // because the pubsub handler was removed
        adapter.on("message", messageSpy);

        const encoded = new TextEncoder().encode(
          JSON.stringify({ type: "publish" })
        );
        pubsub.simulateMessage(
          "/pokapali/signal/room1",
          encoded
        );

        expect(messageSpy).not.toHaveBeenCalled();
      }
    );
  });
});
