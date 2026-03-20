import type { Awareness } from "y-protocols/awareness";
import type { RoomDiscovery } from "./peer-discovery.js";
import { awarenessField } from "./awareness-state.js";

const PUBLISH_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 5_000;

export interface RelaySharingOptions {
  awareness: Awareness;
  roomDiscovery: RoomDiscovery;
}

export interface RelaySharing {
  destroy(): void;
}

export function createRelaySharing(options: RelaySharingOptions): RelaySharing {
  const { awareness, roomDiscovery } = options;
  let destroyed = false;

  const publishRelays = () => {
    if (destroyed) return;
    const entries = roomDiscovery.relayEntries();
    if (entries.length > 0) {
      awareness.setLocalStateField("relays", entries);
    }
  };

  const onAwarenessUpdate = () => {
    if (destroyed) return;
    const states = awareness.getStates();
    for (const [clientId, state] of states) {
      if (clientId === awareness.clientID) continue;
      const relays = awarenessField(state, "relays");
      if (Array.isArray(relays) && relays.length > 0) {
        roomDiscovery.addExternalRelays(relays);
      }
    }
  };

  awareness.on("update", onAwarenessUpdate);

  const publishTimer = setInterval(publishRelays, PUBLISH_INTERVAL_MS);
  const initialTimer = setTimeout(publishRelays, INITIAL_DELAY_MS);

  return {
    destroy() {
      destroyed = true;
      clearInterval(publishTimer);
      clearTimeout(initialTimer);
      awareness.off("update", onAwarenessUpdate);
    },
  };
}
