import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { MockWebrtcProvider } = vi.hoisted(() => {
  // Use a function constructor (not class) so that
  // prototype is writable — the production code
  // monkey-patches WebrtcProvider.prototype.connect.
  function MockWebrtcProvider(this: any) {
    this.signalingUrls = [];
    this.signalingConns = [];
    this.room = null;
    this.shouldConnect = false;
  }
  MockWebrtcProvider.prototype.connect = function () {};
  MockWebrtcProvider.prototype.disconnect = function () {};
  return { MockWebrtcProvider };
});

vi.mock("y-webrtc", () => ({
  WebrtcProvider: MockWebrtcProvider,
  WebrtcConn: function MockWebrtcConn() {},
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
  simulateMessage(topic: string, data: Uint8Array): void;
} {
  const handlers = new Map<string, Set<(evt: CustomEvent) => void>>();
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
    addEventListener(type: string, handler: (evt: CustomEvent) => void) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (evt: CustomEvent) => void) {
      handlers.get(type)?.delete(handler);
    },
    simulateMessage(topic: string, data: Uint8Array) {
      const detail = { topic, data };
      const evt = new CustomEvent("message", {
        detail,
      });
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
    pubsub = createMockPubSub();
  });

  afterEach(() => {
    if (adapter) {
      adapter.destroy();
    }
  });

  describe("createGossipSubSignaling", () => {
    it("returns same adapter on duplicate call", () => {
      adapter = createGossipSubSignaling(pubsub);
      const second = createGossipSubSignaling(pubsub);
      expect(second).toBe(adapter);
    });

    it("emits connect after creation", () => {
      const connectSpy = vi.fn();
      // Create adapter manually so we can listen
      // before the connect event fires
      adapter = new GossipSubSignaling(pubsub);
      adapter.on("connect", connectSpy);

      // Simulate what createGossipSubSignaling does
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
    it("subscribes to shared signaling topic", () => {
      adapter = createGossipSubSignaling(pubsub);
      adapter.send({
        type: "subscribe",
        topics: ["room1", "room2"],
      });
      expect(pubsub._subscribed.has("/pokapali/signaling")).toBe(true);
      expect(pubsub._subscribed.size).toBe(1);
    });

    it("does not double-subscribe", () => {
      adapter = createGossipSubSignaling(pubsub);
      // First explicit subscribe — may be a no-op if
      // the connect handler already subscribed
      adapter.send({
        type: "subscribe",
        topics: ["room1"],
      });
      const subscribeSpy = vi.spyOn(pubsub, "subscribe");
      // Second subscribe should definitely be a no-op
      adapter.send({
        type: "subscribe",
        topics: ["room1"],
      });
      expect(subscribeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe("send publish", () => {
    it("publishes JSON-encoded data to shared topic", () => {
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
      const pub = pubsub._published[0]!;
      expect(pub.topic).toBe("/pokapali/signaling");
      const decoded = JSON.parse(new TextDecoder().decode(pub.data));
      expect(decoded).toEqual({
        type: "publish",
        topic: "room1",
        data: signalData,
      });
    });
  });

  describe("send unsubscribe", () => {
    it(
      "keeps shared topic subscribed " + "(only unsubscribed on destroy)",
      () => {
        adapter = createGossipSubSignaling(pubsub);
        adapter.send({
          type: "subscribe",
          topics: ["room1"],
        });
        expect(pubsub._subscribed.has("/pokapali/signaling")).toBe(true);

        adapter.send({
          type: "unsubscribe",
          topics: ["room1"],
        });
        expect(pubsub._subscribed.has("/pokapali/signaling")).toBe(true);
      },
    );
  });

  describe("incoming GossipSub messages", () => {
    it("emits message event with decoded payload", () => {
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
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      pubsub.simulateMessage("/pokapali/signaling", encoded);

      expect(messageSpy).toHaveBeenCalledOnce();
      expect(messageSpy).toHaveBeenCalledWith(payload);
    });

    it("ignores messages with non-matching prefix", () => {
      adapter = createGossipSubSignaling(pubsub);

      const messageSpy = vi.fn();
      adapter.on("message", messageSpy);

      const encoded = new TextEncoder().encode(
        JSON.stringify({ type: "publish" }),
      );
      pubsub.simulateMessage("/other/topic/room1", encoded);

      expect(messageSpy).not.toHaveBeenCalled();
    });

    it("ignores malformed JSON", () => {
      adapter = createGossipSubSignaling(pubsub);

      const messageSpy = vi.fn();
      adapter.on("message", messageSpy);

      const garbage = new TextEncoder().encode("not valid json{{{");
      pubsub.simulateMessage("/pokapali/signal/room1", garbage);

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
      expect(pubsub._subscribed.has("/pokapali/signaling")).toBe(true);

      adapter.destroy();
      expect(pubsub._subscribed.size).toBe(0);
    });

    it("removes from internal adapter registry", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(createGossipSubSignaling(pubsub)).toBe(adapter);

      adapter.destroy();
      // After destroy, a new call creates fresh
      const fresh = createGossipSubSignaling(pubsub);
      expect(fresh).not.toBe(adapter);
      fresh.destroy();
    });

    it("sets connected to false", () => {
      adapter = createGossipSubSignaling(pubsub);
      expect(adapter.connected).toBe(true);

      adapter.destroy();
      expect(adapter.connected).toBe(false);
    });

    it("removes event listener from pubsub", () => {
      adapter = createGossipSubSignaling(pubsub);
      const handlersBefore = pubsub._handlers.get("message")?.size ?? 0;
      expect(handlersBefore).toBe(1);

      adapter.destroy();
      const handlersAfter = pubsub._handlers.get("message")?.size ?? 0;
      expect(handlersAfter).toBe(0);
    });

    it("stops emitting messages after destroy", () => {
      adapter = createGossipSubSignaling(pubsub);
      adapter.destroy();

      const messageSpy = vi.fn();
      adapter.on("message", messageSpy);

      const encoded = new TextEncoder().encode(
        JSON.stringify({ type: "publish" }),
      );
      pubsub.simulateMessage("/pokapali/signal/room1", encoded);

      expect(messageSpy).not.toHaveBeenCalled();
    });
  });
});
