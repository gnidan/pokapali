/**
 * Publish this browser's relay connections via
 * awareness so other peers can build a full
 * network graph.
 *
 * Each browser publishes:
 *   awareness.topology = {
 *     connectedRelays: [peerId, ...],
 *     relayRoles: { peerId: ["relay", ...] }
 *   }
 */

import type { Awareness } from "y-protocols/awareness";
import type { NodeRegistry } from "./node-registry.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("topology-sharing");

const DEBOUNCE_MS = 2_000;
const PERIODIC_MS = 30_000;

export interface TopologySharingOptions {
  awareness: Awareness;
  registry: NodeRegistry;
  /** libp2p instance for peer events. */
  libp2p: {
    addEventListener(
      type: string,
      fn: (evt: any) => void,
    ): void;
    removeEventListener(
      type: string,
      fn: (evt: any) => void,
    ): void;
  };
}

export interface TopologySharing {
  /** Force an immediate publish. */
  publishNow(): void;
  destroy(): void;
}

export interface AwarenessTopology {
  connectedRelays: string[];
  relayRoles: Record<string, string[]>;
}

export function createTopologySharing(
  options: TopologySharingOptions,
): TopologySharing {
  const { awareness, registry, libp2p } = options;
  let debounceTimer: ReturnType<
    typeof setTimeout
  > | null = null;

  function publish() {
    const relays: string[] = [];
    const roles: Record<string, string[]> = {};
    for (const node of registry.nodes.values()) {
      if (!node.connected) continue;
      if (
        !node.roles.includes("relay") &&
        !node.roles.includes("pinner")
      ) {
        continue;
      }
      relays.push(node.peerId);
      roles[node.peerId] = node.roles;
    }
    const topo: AwarenessTopology = {
      connectedRelays: relays,
      relayRoles: roles,
    };
    awareness.setLocalStateField("topology", topo);
    log.debug(
      "published topology:",
      relays.length, "relays",
    );
  }

  function schedulePublish() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      publish();
    }, DEBOUNCE_MS);
  }

  const connectHandler = () => schedulePublish();
  const disconnectHandler = () => schedulePublish();

  libp2p.addEventListener(
    "peer:connect", connectHandler,
  );
  libp2p.addEventListener(
    "peer:disconnect", disconnectHandler,
  );

  const periodicTimer = setInterval(
    publish, PERIODIC_MS,
  );

  // Initial publish after a short delay to let
  // connections stabilize.
  const initialTimer = setTimeout(publish, DEBOUNCE_MS);

  return {
    publishNow() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      publish();
    },

    destroy() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearInterval(periodicTimer);
      clearTimeout(initialTimer);
      libp2p.removeEventListener(
        "peer:connect", connectHandler,
      );
      libp2p.removeEventListener(
        "peer:disconnect", disconnectHandler,
      );
    },
  };
}
