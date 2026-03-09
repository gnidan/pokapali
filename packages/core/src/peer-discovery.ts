import type { Helia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createLogger } from "@pokapali/log";
import {
  loadCachedRelays,
  upsertCachedRelay,
} from "./relay-cache.js";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 30_000;
const FIND_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 10_000;
const LOG_INTERVAL_MS = 15_000;
const RELAY_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h
const RECONNECT_BASE_DELAY_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 8;
// Tag value for relay peers. Protects from connection
// pruning (pruner drops lowest-value peers first)
// without using KEEP_ALIVE (which triggers libp2p's
// ReconnectQueue and causes a dual-reconnection race).
const RELAY_TAG = "pokapali-relay";
const RELAY_TAG_VALUE = 100;

const log = createLogger("discovery");

async function networkCID(): Promise<CID> {
  const bytes = new TextEncoder().encode(
    "pokapali-network",
  );
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

// --- Address filtering ---

export function extractWssAddrs(
  pid: string,
  rawAddrs: string[],
  isSecureContext: boolean,
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

  const secure =
    typeof globalThis.location !== "undefined" &&
    globalThis.location.protocol === "https:";

  function wssAddrs(
    pid: string,
    rawAddrs: string[],
  ) {
    return extractWssAddrs(pid, rawAddrs, secure);
  }

  function tagRelay(pid: string) {
    const conn = helia.libp2p.getConnections()
      .find(
        (c) => c.remotePeer.toString() === pid,
      );
    if (!conn) return;
    helia.libp2p.peerStore.merge(
      conn.remotePeer,
      {
        tags: {
          [RELAY_TAG]: { value: RELAY_TAG_VALUE },
        },
      },
    ).catch(() => {});
  }

  function untagRelay(pid: string) {
    const conn = helia.libp2p.getConnections()
      .find(
        (c) => c.remotePeer.toString() === pid,
      );
    if (!conn) return;
    helia.libp2p.peerStore.merge(
      conn.remotePeer,
      { tags: { [RELAY_TAG]: undefined } },
    ).catch(() => {});
  }

  function trackRelay(pid: string, addrs: string[]) {
    relayPeerIds.add(pid);
    relayAddrs.set(pid, addrs);
    tagRelay(pid);
  }

  function untrackRelay(pid: string) {
    relayPeerIds.delete(pid);
    relayAddrs.delete(pid);
    untagRelay(pid);
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
        log.debug(
          `cached relay ...${short} (connected)`,
        );
        return;
      }

      const dialAddrs = wssAddrs(
        pid,
        entry.addrs,
      );
      if (dialAddrs.length === 0) return;

      const ok = await dialRelay(
        pid, dialAddrs, entry.addrs,
      );
      if (ok) {
        upsertCachedRelay(pid, entry.addrs);
      }
      // Don't evict on failure — the 24h TTL in
      // loadCachedRelays handles natural expiry.
    }));
  }

  interface ProviderToDial {
    pid: string;
    filtered: ReturnType<typeof multiaddr>[];
    addrs: string[];
    peerId: any;
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

      // Phase 1: collect providers from iterator
      // (bounded by FIND_TIMEOUT_MS). Slow dials no
      // longer block iteration.
      const toDial: ProviderToDial[] = [];
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

        const filtered = wssAddrs(pid, addrs);
        toDial.push({
          pid, filtered, addrs,
          peerId: provider.id,
        });
      }

      clearTimeout(timeout);
      if (found > 0) {
        log.info(`found ${found} relay(s)`);
      }

      // Phase 2: dial all collected providers in
      // parallel (each with its own DIAL_TIMEOUT).
      if (toDial.length > 0) {
        await Promise.allSettled(
          toDial.map(async (p) => {
            const ok = await dialRelay(
              p.pid,
              p.filtered,
              p.addrs,
              p.peerId,
            );
            if (ok) {
              upsertCachedRelay(p.pid, p.addrs);
            }
          }),
        );
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
  //
  // We tag relays (not KEEP_ALIVE) for pruning
  // protection. Our own handler manages reconnection
  // with exponential backoff. Relays stay in
  // relayPeerIds during the reconnect window so
  // they remain visible in diagnostics and relay
  // sharing. Only fully untracked after all attempts
  // are exhausted.

  const reconnectTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const reconnectAttempts = new Map<string, number>();

  const disconnectHandler = (
    evt: CustomEvent,
  ) => {
    const peerId = evt.detail;
    const pid = peerId.toString();
    if (!relayPeerIds.has(pid)) return;
    const short = pid.slice(-8);

    // Cancel any pending redial for this peer.
    const existing = reconnectTimers.get(pid);
    if (existing) clearTimeout(existing);

    if (stopped) return;

    const attempts =
      reconnectAttempts.get(pid) ?? 0;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      log.info(
        `relay ...${short} disconnected,`,
        `max attempts reached — removing`,
      );
      reconnectAttempts.delete(pid);
      untrackRelay(pid);
      return;
    }

    const delay = RECONNECT_BASE_DELAY_MS
      * Math.pow(2, attempts);
    log.info(
      `relay ...${short} disconnected,`,
      `redial in ${delay / 1000}s`,
      `(attempt ${attempts + 1})`,
    );

    reconnectTimers.set(
      pid,
      setTimeout(async () => {
        reconnectTimers.delete(pid);
        if (stopped) return;

        const cached = loadCachedRelays().find(
          (r) => r.peerId === pid,
        );
        if (!cached) {
          untrackRelay(pid);
          return;
        }

        const redialAddrs = wssAddrs(
          pid, cached.addrs,
        );
        if (redialAddrs.length === 0) {
          untrackRelay(pid);
          return;
        }

        const ok = await dialRelay(
          pid, redialAddrs, cached.addrs,
        );
        if (ok) {
          reconnectAttempts.delete(pid);
          upsertCachedRelay(pid, cached.addrs);
          log.info(
            `relay ...${short} reconnected`,
          );
        } else {
          reconnectAttempts.set(
            pid, attempts + 1,
          );
        }
      }, delay),
    );
  };

  helia.libp2p.addEventListener(
    "peer:disconnect",
    disconnectHandler,
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
        log.debug(
          `peer-shared relay ...${short}`,
          `(connected)`,
        );
        upsertCachedRelay(pid, entry.addrs);
        continue;
      }

      const extAddrs = wssAddrs(
        pid, entry.addrs,
      );
      if (extAddrs.length === 0) continue;

      log.debug(
        `peer-shared relay ...${short}`,
      );
      const ok = await dialRelay(
        pid, extAddrs, entry.addrs,
      );
      if (ok) {
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
      for (const timer of reconnectTimers.values()) {
        clearTimeout(timer);
      }
      reconnectTimers.clear();
      reconnectAttempts.clear();
      helia.libp2p.removeEventListener(
        "peer:disconnect",
        disconnectHandler,
      );
    },
  };
}
