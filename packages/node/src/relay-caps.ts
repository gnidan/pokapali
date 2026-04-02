import type { Helia } from "helia";
import type {
  PubSub,
  Message,
  SubscriptionChangeData,
} from "@libp2p/interface";
import { createLogger } from "@pokapali/log";

const log = createLogger("relay");

export function nodeCapsTopic(networkId: string): string {
  return `pokapali.${networkId}._node-caps._p2p._pubsub`;
}

/** @deprecated Use nodeCapsTopic(networkId) instead. */
export const NODE_CAPS_TOPIC = nodeCapsTopic("main");

export interface NodeNeighbor {
  peerId: string;
  role?: string;
}

export interface NodeCapabilities {
  version: 2;
  peerId: string;
  roles: string[];
  neighbors?: NodeNeighbor[];
  browserCount?: number;
  /** Public WSS addresses for direct dialing. */
  addrs?: string[];
  /** HTTPS block endpoint URL. */
  httpUrl?: string;
}

export function encodeNodeCaps(caps: NodeCapabilities): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(caps));
}

export function decodeNodeCaps(data: Uint8Array): NodeCapabilities | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(data));
    if (
      (obj?.version !== 1 && obj?.version !== 2) ||
      typeof obj.peerId !== "string" ||
      !Array.isArray(obj.roles)
    ) {
      return null;
    }
    return obj as NodeCapabilities;
  } catch {
    return null;
  }
}

/**
 * Listen for incoming caps messages on pubsub and
 * track peer roles. Returns a cleanup function.
 */
export function setupCapsListener(
  pubsub: PubSub,
  selfPeerId: string,
  knownPeerRoles: Map<string, string[]>,
  networkId = "main",
): () => void {
  const capsTopic = nodeCapsTopic(networkId);
  const handler = (evt: CustomEvent<Message>) => {
    const msg = evt.detail;
    if (msg.topic !== capsTopic) return;
    const caps = decodeNodeCaps(msg.data);
    if (!caps || caps.peerId === selfPeerId) return;
    knownPeerRoles.set(caps.peerId, caps.roles);
  };
  pubsub.addEventListener("message", handler);
  return () => pubsub.removeEventListener("message", handler);
}

/**
 * Dynamic app-topic subscription: when peers
 * subscribe to announcement topics, the relay
 * auto-subscribes so it joins the mesh and can
 * forward messages. This makes the relay fully
 * app-agnostic — no pinAppIds config needed.
 *
 * Originator refcounting prevents relay-to-relay
 * keep-alive deadlock: only non-relay peers
 * (browsers) count as originators. When the last
 * originator leaves, the relay unsubscribes —
 * other relays see the change and cascade.
 */
export function setupDynamicSubscription(
  pubsub: PubSub,
  knownPeerRoles: Map<string, string[]>,
): {
  autoSubOriginators: Map<string, Set<string>>;
  remove: () => void;
} {
  const ANNOUNCE_PREFIX = "/pokapali/app/";
  const ANNOUNCE_SUFFIX = "/announce";
  const autoSubOriginators = new Map<string, Set<string>>();

  function isAnnounceTopic(topic: string): boolean {
    return topic.startsWith(ANNOUNCE_PREFIX) && topic.endsWith(ANNOUNCE_SUFFIX);
  }

  function isRelayPeer(peerId: string): boolean {
    const peerRoles = knownPeerRoles.get(peerId);
    return (
      !!peerRoles &&
      (peerRoles.includes("relay") || peerRoles.includes("pinner"))
    );
  }

  const handler = (evt: CustomEvent<SubscriptionChangeData>) => {
    const peer = evt.detail.peerId.toString();
    const subs = evt.detail.subscriptions;
    for (const sub of subs) {
      if (!isAnnounceTopic(sub.topic)) continue;
      if (isRelayPeer(peer)) continue;

      if (sub.subscribe) {
        let originators = autoSubOriginators.get(sub.topic);
        if (!originators) {
          originators = new Set();
          autoSubOriginators.set(sub.topic, originators);
          pubsub.subscribe(sub.topic);
          log.info("auto-subscribed to", sub.topic);
        }
        originators.add(peer);
      } else {
        const originators = autoSubOriginators.get(sub.topic);
        if (originators) {
          originators.delete(peer);
        }
      }
    }
  };

  pubsub.addEventListener("subscription-change", handler);
  return {
    autoSubOriginators,
    remove: () => pubsub.removeEventListener("subscription-change", handler),
  };
}

/**
 * Publish our capabilities to the caps topic.
 * Also cleans up auto-subscribed topics with no
 * remaining non-relay originators.
 */
export function publishCaps(
  helia: Helia,
  pubsub: PubSub,
  selfPeerId: string,
  roles: string[],
  knownPeerRoles: Map<string, string[]>,
  autoSubOriginators: Map<string, Set<string>>,
  httpUrl: string | undefined,
  networkId = "main",
): void {
  const capsTopic = nodeCapsTopic(networkId);
  // Clean up auto-subscribed topics with no
  // remaining non-relay originators.
  for (const [topic, originators] of autoSubOriginators) {
    const connPids = new Set(
      helia.libp2p.getConnections().map((c) => c.remotePeer.toString()),
    );
    for (const pid of originators) {
      if (!connPids.has(pid)) {
        originators.delete(pid);
      }
    }
    if (originators.size === 0) {
      pubsub.unsubscribe(topic);
      autoSubOriginators.delete(topic);
      log.info("auto-unsubscribed from", topic);
    }
  }

  // Build neighbor list from connected peers
  // with known roles (relays/pinners).
  const conns = helia.libp2p.getConnections();
  const connectedPids = new Set<string>();
  for (const conn of conns) {
    connectedPids.add(conn.remotePeer.toString());
  }

  // Prune stale entries from knownPeerRoles
  for (const pid of knownPeerRoles.keys()) {
    if (!connectedPids.has(pid)) {
      knownPeerRoles.delete(pid);
    }
  }

  const neighbors: NodeNeighbor[] = [];
  let browserCount = 0;
  for (const pid of connectedPids) {
    const peerRoles = knownPeerRoles.get(pid);
    if (peerRoles && peerRoles.length > 0) {
      neighbors.push({
        peerId: pid,
        role: peerRoles[0],
      });
    } else {
      browserCount++;
    }
  }

  const addrs = helia.libp2p
    .getMultiaddrs()
    .filter((ma) => ma.toString().includes("/tls/"))
    .map((ma) => ma.toString());

  log.info(
    `caps: ${neighbors.length} neighbors,` +
      ` ${browserCount} browsers,` +
      ` ${knownPeerRoles.size} known peers,` +
      ` ${addrs.length} addrs`,
  );
  const msg = encodeNodeCaps({
    version: 2,
    peerId: selfPeerId,
    roles,
    neighbors: neighbors.length > 0 ? neighbors : undefined,
    browserCount,
    addrs: addrs.length > 0 ? addrs : undefined,
    httpUrl,
  });
  pubsub.publish(capsTopic, msg).catch((err: unknown) => {
    log.warn("caps publish failed:", err);
  });
}
