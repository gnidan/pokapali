import { Observable } from "lib0/observable";
import { WebrtcProvider, WebrtcConn } from "y-webrtc";
import { setIfUndefined } from "lib0/map";
import { toBase64, fromBase64 } from "lib0/buffer";
import {
  createEncoder,
  writeAny,
  writeUint8Array,
  writeVarUint8Array,
  toUint8Array,
} from "lib0/encoding";
import {
  createDecoder,
  readUint8Array,
  readVarUint8Array,
  readAny,
} from "lib0/decoding";
import { createLogger } from "@pokapali/log";
import type { ThrottledInterval } from "./throttled-interval.js";
import { createThrottledInterval } from "./throttled-interval.js";

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

/**
 * Module-level adapter registry. Replaces y-webrtc's
 * internal signalingConns Map for our adapters.
 */
const adapters = new Map<string, GossipSubSignaling>();

// ---- Crypto helpers (from y-webrtc/src/crypto.js) ----

async function encryptJson(data: unknown, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dataEnc = createEncoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeAny(dataEnc, data as any);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    toUint8Array(dataEnc),
  );
  const result = createEncoder();
  writeUint8Array(result, iv);
  writeVarUint8Array(result, new Uint8Array(encrypted));
  return toUint8Array(result);
}

async function decryptJson(data: Uint8Array, key: CryptoKey): Promise<unknown> {
  const decoder = createDecoder(data);
  const iv = readUint8Array(decoder, 12);
  const encrypted = readVarUint8Array(decoder);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encrypted as unknown as BufferSource,
  );
  return readAny(createDecoder(new Uint8Array(decrypted)));
}

// ---- WebrtcProvider monkey-patch ----
//
// Intercepts connect() so that our adapter URL
// ("libp2p:gossipsub") doesn't trigger a WebSocket
// SignalingConn creation. Instead, our GossipSub
// adapter is pushed directly into the provider's
// signalingConns array.

const connectPatched = Symbol("gossipsub-patched");

/* eslint-disable @typescript-eslint/no-explicit-any */
if (!(WebrtcProvider.prototype as any)[connectPatched]) {
  (WebrtcProvider.prototype as any)[connectPatched] = true;
  const origConnect = WebrtcProvider.prototype.connect;
  WebrtcProvider.prototype.connect = function () {
    const allUrls = [...(this as any).signalingUrls] as string[];
    const adapterUrls = allUrls.filter((u) => adapters.has(u));

    // Remove adapter URLs so original connect doesn't
    // try to create WebSocket SignalingConns for them
    (this as any).signalingUrls = allUrls.filter((u) => !adapters.has(u));

    origConnect.call(this);

    // Restore full URL list
    (this as any).signalingUrls = allUrls;

    // Push our adapters into this provider's conns
    for (const url of adapterUrls) {
      const adapter = adapters.get(url)!;
      const conns = (this as any).signalingConns as unknown[];
      if (!conns.includes(adapter)) {
        conns.push(adapter);
        adapter.providers.add(this);
      }
    }
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- Signal routing ----
//
// Replaces y-webrtc's setupSignalingHandlers. Routes
// incoming signaling messages to the correct Room and
// creates WebrtcConns for peer discovery.

/* eslint-disable @typescript-eslint/no-explicit-any */
function publishSignaling(
  adapter: GossipSubSignaling,
  room: any,
  data: unknown,
): void {
  if (room.key) {
    encryptJson(data, room.key).then((enc: Uint8Array) => {
      adapter.send({
        type: "publish",
        topic: room.name,
        data: toBase64(enc),
      });
    });
  } else {
    adapter.send({
      type: "publish",
      topic: room.name,
      data,
    });
  }
}

function handleConnect(adapter: GossipSubSignaling): void {
  const topics: string[] = [];
  for (const provider of adapter.providers) {
    const room = (provider as any).room;
    if (room) topics.push(room.name);
  }
  adapter.send({ type: "subscribe", topics });
  for (const provider of adapter.providers) {
    const room = (provider as any).room;
    if (room) {
      publishSignaling(adapter, room, {
        type: "announce",
        from: room.peerId,
      });
    }
  }
}

function routeMessage(adapter: GossipSubSignaling, msg: any): void {
  if (msg.type !== "publish") return;
  const roomName = msg.topic;
  if (typeof roomName !== "string") return;

  // Find room through providers
  let room: any = null;
  for (const provider of adapter.providers) {
    const r = (provider as any).room;
    if (r?.name === roomName) {
      room = r;
      break;
    }
  }
  if (!room) return;

  const execMessage = (data: any) => {
    if (data == null) return;
    const webrtcConns = room.webrtcConns as Map<string, any>;
    const peerId: string = room.peerId;
    if (
      data.from === peerId ||
      (data.to !== undefined && data.to !== peerId) ||
      room.bcConns.has(data.from)
    ) {
      return;
    }
    const emitPeerChange = webrtcConns.has(data.from)
      ? () => {}
      : () =>
          room.provider.emit("peers", [
            {
              removed: [],
              added: [data.from],
              webrtcPeers: Array.from(webrtcConns.keys()),
              bcPeers: Array.from(room.bcConns),
            },
          ]);
    switch (data.type) {
      case "announce":
        if (webrtcConns.size < room.provider.maxConns) {
          setIfUndefined(
            webrtcConns,
            data.from,
            () => new (WebrtcConn as any)(adapter, true, data.from, room),
          );
          emitPeerChange();
        }
        break;
      case "signal":
        if (data.signal.type === "offer") {
          const existing = webrtcConns.get(data.from);
          if (existing) {
            if (existing.glareToken && existing.glareToken > data.token) {
              log.debug("offer rejected:", data.from);
              return;
            }
            existing.glareToken = undefined;
          }
        }
        if (data.signal.type === "answer") {
          log.debug("offer answered by:", data.from);
          const existing = webrtcConns.get(data.from);
          if (existing) {
            existing.glareToken = undefined;
          }
        }
        if (data.to === peerId) {
          setIfUndefined(
            webrtcConns,
            data.from,
            () => new (WebrtcConn as any)(adapter, false, data.from, room),
          ).peer.signal(data.signal);
          emitPeerChange();
        }
        break;
    }
  };

  if (room.key) {
    if (typeof msg.data === "string") {
      decryptJson(fromBase64(msg.data), room.key).then(execMessage, (err) => {
        // Second arg only catches decryptJson
        // rejection — execMessage errors propagate.
        //
        // All signaling shares one GossipSub topic,
        // so messages from other documents with
        // different keys are common. These produce:
        //
        // OperationError: AES-GCM auth failure
        //   (key mismatch)
        // RangeError: garbage varint length from
        //   ciphertext encoded with a different key
        //
        // Logged at debug to surface real key issues.
        if (
          err instanceof RangeError ||
          (err instanceof DOMException && err.name === "OperationError")
        ) {
          log.debug(
            "signaling decrypt failed for room",
            roomName + ":",
            err.message,
          );
          return;
        }
        throw err;
      });
    }
  } else {
    execMessage(msg.data);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- GossipSubSignaling ----

export class GossipSubSignaling extends Observable<string> {
  readonly url = ADAPTER_KEY;
  readonly providers = new Set<unknown>();

  connected = false;

  private readonly pubsub: PubSubLike;
  private readonly subscribedTopics = new Set<string>();
  private readonly gossipHandler: (evt: CustomEvent) => void;
  private announceInterval: ThrottledInterval | null = null;

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

    // Wire up signal routing (replaces y-webrtc's
    // setupSignalingHandlers)
    this.on("connect", () => handleConnect(this));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.on("message", (msg: any) => routeMessage(this, msg));
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
          log.debug(
            `publish ${message.topic}:`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (message.data as any)?.type,
          );
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
    this.announceInterval = createThrottledInterval(
      () => {
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
      },
      15_000,
      { backgroundMs: 0, fireOnResume: true },
    );
  }

  destroy(): void {
    if (this.announceInterval) {
      this.announceInterval.destroy();
      this.announceInterval = null;
    }
    if (this.subscribedTopics.has(SIGNALING_TOPIC)) {
      this.pubsub.unsubscribe(SIGNALING_TOPIC);
    }
    this.subscribedTopics.clear();
    this.pubsub.removeEventListener("message", this.gossipHandler);
    this.connected = false;
    adapters.delete(ADAPTER_KEY);
    super.destroy();
  }
}

/**
 * Create a GossipSub-backed signaling adapter for
 * y-webrtc. The adapter registers itself in our
 * internal adapter map and monkey-patches
 * WebrtcProvider.connect() so that providers created
 * with the "libp2p:gossipsub" signaling URL use this
 * adapter instead of opening a WebSocket.
 */
export function createGossipSubSignaling(
  pubsub: PubSubLike,
): GossipSubSignaling {
  const existing = adapters.get(ADAPTER_KEY);
  if (existing) {
    return existing;
  }

  const adapter = new GossipSubSignaling(pubsub);

  // Register so the connect monkey-patch can find it
  adapters.set(ADAPTER_KEY, adapter);

  // Mark connected and fire 'connect' so the handlers
  // immediately subscribe to existing rooms.
  adapter.connected = true;
  adapter.emit("connect", []);

  // Periodically re-announce so that peers joining
  // after initial connect still discover us.
  adapter.startAnnounceInterval();

  return adapter;
}
