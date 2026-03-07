import { Observable } from "lib0/observable";
import {
  signalingConns,
  setupSignalingHandlers,
} from "y-webrtc";

/**
 * Minimal subset of @libp2p/interface PubSub needed by
 * the adapter so we avoid a hard dep on @libp2p/interface.
 */
export interface PubSubLike {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: Uint8Array): Promise<unknown>;
  addEventListener(
    type: string,
    handler: (evt: CustomEvent) => void
  ): void;
  removeEventListener(
    type: string,
    handler: (evt: CustomEvent) => void
  ): void;
}

const ADAPTER_KEY = "libp2p:gossipsub";
const TOPIC_PREFIX = "/pokapali/signal/";

const log = (...args: unknown[]) =>
  console.log("[pokapali:gossipsub]", ...args);

export class GossipSubSignaling extends Observable<string> {
  readonly url = ADAPTER_KEY;
  readonly providers = new Set<unknown>();

  connected = false;

  private readonly pubsub: PubSubLike;
  private readonly subscribedTopics = new Set<string>();
  private readonly gossipHandler: (evt: CustomEvent) => void;

  constructor(pubsub: PubSubLike) {
    super();
    this.pubsub = pubsub;

    this.gossipHandler = (evt: CustomEvent) => {
      const msg = evt.detail;
      if (!msg || !msg.topic || !msg.data) {
        return;
      }
      const topic = msg.topic as string;
      if (!topic.startsWith(TOPIC_PREFIX)) {
        return;
      }

      try {
        const text = new TextDecoder().decode(msg.data);
        const parsed = JSON.parse(text);
        const short = topic.replace(TOPIC_PREFIX, "");
        log(`recv on ${short}:`, parsed?.data?.type);
        this.emit("message", [parsed]);
      } catch {
        // malformed message — ignore
      }
    };

    this.pubsub.addEventListener(
      "message",
      this.gossipHandler
    );
  }

  send(message: {
    type: string;
    topics?: string[];
    topic?: string;
    data?: unknown;
  }): void {
    switch (message.type) {
      case "subscribe": {
        const topics = message.topics ?? [];
        for (const t of topics) {
          const fullTopic = `${TOPIC_PREFIX}${t}`;
          if (!this.subscribedTopics.has(fullTopic)) {
            log(`subscribe ${t}`);
            this.pubsub.subscribe(fullTopic);
            this.subscribedTopics.add(fullTopic);
          }
        }
        break;
      }
      case "unsubscribe": {
        const topics = message.topics ?? [];
        for (const t of topics) {
          const fullTopic = `${TOPIC_PREFIX}${t}`;
          if (this.subscribedTopics.has(fullTopic)) {
            this.pubsub.unsubscribe(fullTopic);
            this.subscribedTopics.delete(fullTopic);
          }
        }
        break;
      }
      case "publish": {
        if (message.topic && message.data !== undefined) {
          const fullTopic =
            `${TOPIC_PREFIX}${message.topic}`;
          const payload = new TextEncoder().encode(
            JSON.stringify({
              type: "publish",
              topic: message.topic,
              data: message.data,
            })
          );
          log(
            `publish ${message.topic}:`,
            (message.data as any)?.type,
          );
          this.pubsub.publish(fullTopic, payload)
            .catch(() => {
              // NoPeersSubscribedToTopic is normal at
              // startup — no peers listening yet.
            });
        }
        break;
      }
    }
  }

  destroy(): void {
    for (const t of this.subscribedTopics) {
      this.pubsub.unsubscribe(t);
    }
    this.subscribedTopics.clear();
    this.pubsub.removeEventListener(
      "message",
      this.gossipHandler
    );
    this.connected = false;
    signalingConns.delete(ADAPTER_KEY);
    super.destroy();
  }
}

/**
 * Create a GossipSub-backed signaling adapter for
 * y-webrtc. The adapter registers itself in y-webrtc's
 * internal `signalingConns` map and sets up the standard
 * signaling handlers so that WebrtcProvider rooms
 * automatically use it for peer discovery / signaling.
 */
export function createGossipSubSignaling(
  pubsub: PubSubLike
): GossipSubSignaling {
  const existing = signalingConns.get(ADAPTER_KEY);
  if (existing) {
    return existing as unknown as GossipSubSignaling;
  }

  const adapter = new GossipSubSignaling(pubsub);

  // Register in y-webrtc's module-level map so rooms
  // can iterate over it for announcements.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signalingConns.set(ADAPTER_KEY, adapter as any);

  // Wire up the standard signaling message handlers
  // (subscribe/publish/announce routing).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setupSignalingHandlers(adapter as any);

  // Mark connected and fire 'connect' so the handlers
  // immediately subscribe to existing rooms.
  adapter.connected = true;
  adapter.emit("connect", []);

  return adapter;
}
