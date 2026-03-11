import { Observable } from "lib0/observable";
import { signalingConns, setupSignalingHandlers } from "y-webrtc";
import { createLogger } from "@pokapali/log";

/**
 * Minimal subset of @libp2p/interface PubSub needed by
 * the adapter so we avoid a hard dep on @libp2p/interface.
 */
export interface PubSubLike {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: Uint8Array): Promise<unknown>;
  addEventListener(type: string, handler: (evt: CustomEvent) => void): void;
  removeEventListener(type: string, handler: (evt: CustomEvent) => void): void;
}

const ADAPTER_KEY = "libp2p:gossipsub";
const SIGNALING_TOPIC = "/pokapali/signaling";

const log = createLogger("gossipsub");

export class GossipSubSignaling extends Observable<string> {
  readonly url = ADAPTER_KEY;
  readonly providers = new Set<unknown>();

  connected = false;

  private readonly pubsub: PubSubLike;
  private readonly subscribedTopics = new Set<string>();
  private readonly gossipHandler: (evt: CustomEvent) => void;
  private announceInterval: ReturnType<typeof setInterval> | null = null;

  constructor(pubsub: PubSubLike) {
    super();
    this.pubsub = pubsub;

    this.gossipHandler = (evt: CustomEvent) => {
      const msg = evt.detail;
      if (!msg || !msg.data) {
        return;
      }
      if (msg.topic !== SIGNALING_TOPIC) {
        return;
      }

      try {
        const text = new TextDecoder().decode(msg.data);
        const parsed = JSON.parse(text);
        log.debug(`recv ${parsed?.topic}:`, parsed?.data?.type);
        this.emit("message", [parsed]);
      } catch {
        // malformed message — ignore
      }
    };

    this.pubsub.addEventListener("message", this.gossipHandler);
  }

  send(message: {
    type: string;
    topics?: string[];
    topic?: string;
    data?: unknown;
  }): void {
    switch (message.type) {
      case "subscribe": {
        // All signaling goes through one GossipSub
        // topic. Subscribe once; y-webrtc filters by
        // room name in the payload.
        if (!this.subscribedTopics.has(SIGNALING_TOPIC)) {
          log.info("subscribe", SIGNALING_TOPIC);
          this.pubsub.subscribe(SIGNALING_TOPIC);
          this.subscribedTopics.add(SIGNALING_TOPIC);
        }
        break;
      }
      case "unsubscribe": {
        // Keep the subscription alive — other rooms
        // may still need it. Only unsubscribe on
        // destroy().
        break;
      }
      case "publish": {
        if (message.topic && message.data !== undefined) {
          const payload = new TextEncoder().encode(
            JSON.stringify({
              type: "publish",
              topic: message.topic,
              data: message.data,
            }),
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          log.debug(`publish ${message.topic}:`, (message.data as any)?.type);
          this.pubsub.publish(SIGNALING_TOPIC, payload).catch((err) => {
            const msg = (err as Error)?.message ?? "";
            if (msg.includes("NoPeersSubscribed")) {
              log.debug("publish: no peers yet");
            } else if (msg) {
              log.warn("publish error:", msg);
            }
          });
        }
        break;
      }
    }
  }

  startAnnounceInterval(): void {
    if (this.announceInterval) return;
    this.announceInterval = setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = this.pubsub as any;
      const gsPeers = ps.getPeers?.() ?? [];
      const topics = ps.getTopics?.() ?? [];
      const subs = topics.flatMap((t: string) =>
        (ps.getSubscribers?.(t) ?? []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => `${t}:${p.toString().slice(-8)}`,
        ),
      );
      log.debug(
        "re-announce,",
        `gs-peers: ${gsPeers.length},`,
        `topics: ${topics},`,
        `subs: ${subs.length}`,
        subs.length > 0 ? subs : "",
      );
      this.emit("connect", []);
    }, 15_000);
  }

  destroy(): void {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    if (this.subscribedTopics.has(SIGNALING_TOPIC)) {
      this.pubsub.unsubscribe(SIGNALING_TOPIC);
    }
    this.subscribedTopics.clear();
    this.pubsub.removeEventListener("message", this.gossipHandler);
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
  pubsub: PubSubLike,
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

  // Periodically re-announce so that peers joining
  // after initial connect still discover us.
  adapter.startAnnounceInterval();

  return adapter;
}
