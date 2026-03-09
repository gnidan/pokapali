import type { Helia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
import { peerIdFromString } from "@libp2p/peer-id";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createLogger } from "@pokapali/log";
import {
  loadCachedRelays,
  upsertCachedRelay,
  removeCachedRelay,
} from "./relay-cache.js";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 30_000;
const FIND_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 10_000;
const LOG_INTERVAL_MS = 15_000;
const RELAY_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h

const log = createLogger("discovery");

async function networkCID(): Promise<CID> {
  const bytes = new TextEncoder().encode(
    "pokapali-network",
  );
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

// --- Discovery ---

export interface RelayEntry {
  peerId: string;
  addrs: string[];
}

export interface RoomDiscovery {
  /** Peer IDs of relays discovered for this app. */
  readonly relayPeerIds: ReadonlySet<string>;
  /** Current known relay entries for sharing. */
  relayEntries(): RelayEntry[];
  /** Try dialing relays learned from another peer. */
  addExternalRelays(entries: RelayEntry[]): void;
  stop(): void;
}

/**
 * Discover relay nodes by looking up a network-wide CID
 * on the DHT. All relays provide this CID; browsers find
 * them via delegated routing regardless of app.
 * Once connected, pubsub-peer-discovery (configured in
 * helia.ts) handles browser-to-browser discovery.
 *
 * On startup, tries cached relay addresses from
 * localStorage first (fast direct dial), then runs
 * DHT discovery in parallel to refresh the cache.
 */
export function startRoomDiscovery(
  helia: Helia,
  _appId?: string,
): RoomDiscovery {
  let stopped = false;
  let cycleController: AbortController | null = null;
  const relayPeerIds = new Set<string>();
  const relayAddrs = new Map<string, string[]>();

  let running = false;

  async function tagRelay(pid: string) {
    try {
      const peerId = peerIdFromString(pid);
      await helia.libp2p.peerStore.merge(peerId, {
        tags: {
          "keep-alive": { value: 100 },
        },
      });
    } catch (err) {
      log.warn(
        "failed to tag relay:",
        (err as Error).message,
      );
    }
  }

  const isSecureContext =
    typeof globalThis.location !== "undefined" &&
    globalThis.location.protocol === "https:";

  function extractWssAddrs(
    pid: string,
    rawAddrs: string[],
  ): ReturnType<typeof multiaddr>[] {
    const p2pSuffix = `/p2p/${pid}`;
    return rawAddrs
      .filter((s) => {
        if (!s.includes("/ws")) return false;
        if (s.includes("/p2p-circuit")) return false;
        // In HTTPS contexts, skip plain ws (no /tls/)
        if (isSecureContext && !s.includes("/tls/")) {
          return false;
        }
        return true;
      })
      .map((s) =>
        multiaddr(
          s.includes("/p2p/") ? s : s + p2pSuffix,
        ),
      );
  }

  function trackRelay(pid: string, addrs: string[]) {
    relayPeerIds.add(pid);
    relayAddrs.set(pid, addrs);
  }

  function untrackRelay(pid: string) {
    relayPeerIds.delete(pid);
    relayAddrs.delete(pid);
  }

  async function dialRelay(
    pid: string,
    wssAddrs: ReturnType<typeof multiaddr>[],
    rawAddrs: string[],
    peerId?: any,
  ): Promise<boolean> {
    const short = pid.slice(-8);
    log.debug(
      `relay ...${short}, dialing...`,
      wssAddrs.map((ma) => ma.toString()),
    );
    const dialCtrl = new AbortController();
    const dialTimer = setTimeout(
      () => dialCtrl.abort(),
      DIAL_TIMEOUT_MS,
    );
    try {
      if (wssAddrs.length > 0) {
        await helia.libp2p.dial(wssAddrs, {
          signal: dialCtrl.signal,
        });
      } else if (peerId) {
        await helia.libp2p.dial(peerId, {
          signal: dialCtrl.signal,
        });
      } else {
        return false;
      }
      trackRelay(pid, rawAddrs);
      log.info(`relay ...${short} OK`);
      return true;
    } catch (err) {
      const e = err as any;
      log.debug(
        `relay ...${short} FAIL:`,
        e.message ?? err,
      );
      if (e.errors) {
        for (const sub of e.errors) {
          log.debug(
            `  sub-error:`, sub.message ?? sub,
          );
        }
      }
      return false;
    } finally {
      clearTimeout(dialTimer);
    }
  }

  async function dialCachedRelays() {
    const cached = loadCachedRelays();
    const now = Date.now();
    const fresh = cached.filter(
      (r) => now - r.lastSeen < RELAY_CACHE_TTL_MS,
    );
    if (fresh.length === 0) return;

    log.debug(
      `trying ${fresh.length} cached relay(s)`,
    );

    await Promise.all(fresh.map(async (entry) => {
      if (stopped) return;

      const pid = entry.peerId;
      const short = pid.slice(-8);
      const already = helia.libp2p
        .getConnections()
        .some(
          (c) => c.remotePeer.toString() === pid,
        );
      if (already) {
        trackRelay(pid, entry.addrs);
        tagRelay(pid);
        log.debug(
          `cached relay ...${short} (connected)`,
        );
        return;
      }

      const wssAddrs = extractWssAddrs(
        pid,
        entry.addrs,
      );
      if (wssAddrs.length === 0) return;

      const ok = await dialRelay(
        pid, wssAddrs, entry.addrs,
      );
      if (ok) {
        tagRelay(pid);
        upsertCachedRelay(pid, entry.addrs);
      } else {
        // Purge stale entry (wrong peer ID, etc.)
        removeCachedRelay(pid);
      }
    }));
  }

  async function discoverRelays() {
    if (running) return; // skip if previous cycle active
    running = true;

    const ctrl = new AbortController();
    cycleController = ctrl;
    const signal = ctrl.signal;

    try {
      const cid = await networkCID();
      const timeout = setTimeout(
        () => ctrl.abort(),
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
          .getConnections()
          .some(
            (c) => c.remotePeer.toString() === pid,
          );

        if (already) {
          const addrs = (
            provider.multiaddrs ?? []
          ).map((ma: any) => ma.toString());
          trackRelay(pid, addrs);
          tagRelay(pid);
          upsertCachedRelay(pid, addrs);
          log.debug(
            `relay ...${short} (connected)`,
          );
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
          log.debug(
            `relay ...${short} skipped`,
            `(no browser-dialable addrs)`,
          );
          continue;
        }

        const wssAddrs = extractWssAddrs(pid, addrs);

        const ok = await dialRelay(
          pid,
          wssAddrs,
          addrs,
          provider.id,
        );
        if (ok) {
          tagRelay(pid);
          upsertCachedRelay(pid, addrs);
        }
      }

      clearTimeout(timeout);
      if (found > 0) {
        log.info(`found ${found} relay(s)`);
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("abort")) {
        log.warn(`discovery error: ${msg}`);
      }
    } finally {
      running = false;
    }
  }

  function logStatus() {
    const peers = helia.libp2p.getPeers();
    const addrs = helia.libp2p.getMultiaddrs();
    log.debug(
      `${peers.length} peers,`,
      `${addrs.length} listening addrs`,
    );
  }

  // --- Relay reconnection on disconnect ---

  const disconnectHandler = (
    evt: CustomEvent,
  ) => {
    const peerId = evt.detail;
    const pid = peerId.toString();
    if (!relayPeerIds.has(pid)) return;
    const short = pid.slice(-8);

    // Remove from tracked set immediately so
    // relayEntries() doesn't share stale addresses.
    untrackRelay(pid);
    log.info(
      `relay ...${short} disconnected,`,
      `scheduling redial`,
    );

    // Attempt immediate redial from cached addresses.
    const cached = loadCachedRelays().find(
      (r) => r.peerId === pid,
    );
    if (!cached || stopped) return;

    const wssAddrs = extractWssAddrs(
      pid, cached.addrs,
    );
    if (wssAddrs.length === 0) return;

    dialRelay(pid, wssAddrs, cached.addrs).then(
      (ok) => {
        if (ok) {
          trackRelay(pid, cached.addrs);
          tagRelay(pid);
          upsertCachedRelay(pid, cached.addrs);
          log.info(
            `relay ...${short} reconnected`,
          );
        }
      },
    );
  };

  helia.libp2p.addEventListener(
    "peer:disconnect",
    disconnectHandler,
  );

  // When libp2p's ReconnectQueue exhausts retries it
  // strips the keep-alive tag. Re-tag the relay so the
  // next discovery cycle or external relay share can
  // restore the connection with pruning protection.
  const reconnectFailHandler = (
    evt: CustomEvent,
  ) => {
    const peerId = evt.detail;
    const pid = peerId.toString();
    // Only re-tag peers we originally tracked as relays.
    // Check relayAddrs (not relayPeerIds, which was
    // cleared by untrackRelay in the disconnect handler)
    // via the localStorage cache.
    const cached = loadCachedRelays().find(
      (r) => r.peerId === pid,
    );
    if (!cached) return;
    const short = pid.slice(-8);
    log.debug(
      `relay ...${short} reconnect failed,`,
      `re-tagging for future discovery`,
    );
    tagRelay(pid);
  };

  helia.libp2p.addEventListener(
    "peer:reconnect-failure",
    reconnectFailHandler,
  );

  // Try cached relays and DHT discovery concurrently.
  // Cache dials are fast; DHT is slow. No reason to wait.
  logStatus();
  dialCachedRelays();
  discoverRelays();

  // Periodic re-discovery
  const discoverInterval = setInterval(() => {
    if (!stopped) discoverRelays();
  }, DISCOVERY_INTERVAL_MS);

  // Periodic status logging
  const logInterval = setInterval(() => {
    if (!stopped) logStatus();
  }, LOG_INTERVAL_MS);

  async function addExternalRelays(
    entries: RelayEntry[],
  ) {
    for (const entry of entries) {
      if (stopped) break;
      if (relayPeerIds.has(entry.peerId)) continue;

      const pid = entry.peerId;
      const short = pid.slice(-8);
      const already = helia.libp2p
        .getConnections()
        .some(
          (c) => c.remotePeer.toString() === pid,
        );
      if (already) {
        trackRelay(pid, entry.addrs);
        tagRelay(pid);
        log.debug(
          `peer-shared relay ...${short}`,
          `(connected)`,
        );
        upsertCachedRelay(pid, entry.addrs);
        continue;
      }

      const wssAddrs = extractWssAddrs(
        pid, entry.addrs,
      );
      if (wssAddrs.length === 0) continue;

      log.debug(
        `peer-shared relay ...${short}`,
      );
      const ok = await dialRelay(
        pid, wssAddrs, entry.addrs,
      );
      if (ok) {
        tagRelay(pid);
        upsertCachedRelay(pid, entry.addrs);
      }
    }
  }

  return {
    get relayPeerIds(): ReadonlySet<string> {
      return relayPeerIds;
    },
    relayEntries(): RelayEntry[] {
      return [...relayAddrs.entries()].map(
        ([peerId, addrs]) => ({ peerId, addrs }),
      );
    },
    addExternalRelays(entries: RelayEntry[]) {
      addExternalRelays(entries);
    },
    stop() {
      stopped = true;
      cycleController?.abort();
      clearInterval(discoverInterval);
      clearInterval(logInterval);
      helia.libp2p.removeEventListener(
        "peer:disconnect",
        disconnectHandler,
      );
      helia.libp2p.removeEventListener(
        "peer:reconnect-failure",
        reconnectFailHandler,
      );
    },
  };
}
