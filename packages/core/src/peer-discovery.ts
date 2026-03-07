import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 30_000;
const FIND_TIMEOUT_MS = 30_000;
const DIAL_TIMEOUT_MS = 15_000;
const LOG_INTERVAL_MS = 15_000;

const log = (...args: unknown[]) =>
  console.log("[pokapali:discovery]", ...args);

async function appIdToCID(
  appId: string,
): Promise<CID> {
  const bytes = new TextEncoder().encode(
    "pokapali-relay:" + appId,
  );
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

export interface RoomDiscovery {
  stop(): void;
}

/**
 * Discover relay nodes by looking up a well-known CID
 * derived from the app ID. Relay nodes provide this CID
 * on the DHT; browsers find them via delegated routing.
 * Once connected, pubsub-peer-discovery (configured in
 * helia.ts) handles browser-to-browser discovery.
 */
export function startRoomDiscovery(
  helia: Helia,
  appId?: string,
): RoomDiscovery {
  let stopped = false;
  let cycleController: AbortController | null = null;

  async function discoverRelays() {
    if (!appId) return;

    cycleController?.abort();
    cycleController = new AbortController();
    const signal = cycleController.signal;

    try {
      const cid = await appIdToCID(appId);
      const timeout = setTimeout(
        () => cycleController?.abort(),
        FIND_TIMEOUT_MS,
      );

      let found = 0;
      for await (const provider of
        helia.routing.findProviders(cid, { signal })
      ) {
        if (signal.aborted) break;
        found++;

        const pid = provider.id.toString();
        const short = pid.slice(-8);
        const already = helia.libp2p
          .getPeers()
          .some((p) => p.toString() === pid);

        if (already) {
          log(`relay ...${short} (connected)`);
          continue;
        }

        const addrs = provider.multiaddrs?.map(
          (ma: any) => ma.toString(),
        ) ?? [];

        // Only try providers with browser-dialable
        // addresses (ws, wss, webrtc, webrtc-direct)
        const dialable = addrs.some(
          (a: string) =>
            a.includes("/ws/") ||
            a.includes("/ws ") ||
            a.endsWith("/ws") ||
            a.includes("/wss/") ||
            a.endsWith("/wss") ||
            a.includes("/webrtc") ||
            a.includes("/p2p-circuit"),
        );
        if (!dialable && addrs.length > 0) {
          log(
            `relay ...${short} skipped`,
            `(no browser-dialable addrs)`,
          );
          continue;
        }

        log(
          `relay ...${short}, dialing...`,
          addrs.length ? addrs : "(no addrs)",
        );
        try {
          const dialCtrl = new AbortController();
          const dialTimer = setTimeout(
            () => dialCtrl.abort(),
            DIAL_TIMEOUT_MS,
          );
          signal.addEventListener("abort", () =>
            dialCtrl.abort(),
          );
          await helia.libp2p.dial(provider.id, {
            signal: dialCtrl.signal,
          });
          clearTimeout(dialTimer);
          log(`relay ...${short} OK`);
        } catch (err) {
          log(
            `relay ...${short} FAIL:`,
            (err as Error).message ?? err,
          );
        }
      }

      clearTimeout(timeout);
      if (found > 0) {
        log(`found ${found} relay(s)`);
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("abort")) {
        log(`relay discovery error: ${msg}`);
      }
    }
  }

  function logStatus() {
    const peers = helia.libp2p.getPeers();
    const addrs = helia.libp2p.getMultiaddrs();
    log(
      `${peers.length} peers,`,
      `${addrs.length} listening addrs`,
    );
  }

  // Initial discovery after short delay
  const initTimer = setTimeout(() => {
    if (!stopped) {
      logStatus();
      discoverRelays();
    }
  }, 3_000);

  // Periodic re-discovery
  const discoverInterval = setInterval(() => {
    if (!stopped) discoverRelays();
  }, DISCOVERY_INTERVAL_MS);

  // Periodic status logging
  const logInterval = setInterval(() => {
    if (!stopped) logStatus();
  }, LOG_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      cycleController?.abort();
      clearTimeout(initTimer);
      clearInterval(discoverInterval);
      clearInterval(logInterval);
    },
  };
}
