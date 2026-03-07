import type { Helia } from "helia";

const LOG_INTERVAL_MS = 15_000;

const log = (...args: unknown[]) =>
  console.log("[pokapali:discovery]", ...args);

export interface RoomDiscovery {
  stop(): void;
}

/**
 * Log peer connectivity status periodically.
 * Actual peer discovery is handled by
 * @libp2p/pubsub-peer-discovery (configured in helia.ts).
 */
export function startRoomDiscovery(
  helia: Helia,
): RoomDiscovery {
  let stopped = false;

  function logStatus() {
    const peers = helia.libp2p.getPeers();
    const addrs = helia.libp2p.getMultiaddrs();
    log(
      `${peers.length} peers,`,
      `${addrs.length} listening addrs`,
    );
    if (addrs.length > 0) {
      for (const ma of addrs) {
        log(`  ${ma.toString()}`);
      }
    }
  }

  // Initial log after a short delay (let connections
  // establish)
  const initTimer = setTimeout(() => {
    if (!stopped) logStatus();
  }, 3_000);

  const interval = setInterval(() => {
    if (!stopped) logStatus();
  }, LOG_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      clearTimeout(initTimer);
      clearInterval(interval);
    },
  };
}
