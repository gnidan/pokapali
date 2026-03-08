import type { Helia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 30_000;
const FIND_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 10_000;
const LOG_INTERVAL_MS = 15_000;
const RELAY_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h
const RELAY_CACHE_MAX_AGE_MS = 48 * 60 * 60_000; // 48h

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

// --- Relay cache (localStorage) ---

const hasLocalStorage =
  typeof globalThis.localStorage !== "undefined";

interface CachedRelay {
  peerId: string;
  addrs: string[];
  lastSeen: number;
}

function cacheKey(appId: string): string {
  return `pokapali:relays:${appId}`;
}

function loadCachedRelays(
  appId: string,
): CachedRelay[] {
  if (!hasLocalStorage) return [];
  try {
    const raw = localStorage.getItem(cacheKey(appId));
    if (!raw) return [];
    const entries: CachedRelay[] = JSON.parse(raw);
    const now = Date.now();
    // Drop entries older than max age
    return entries.filter(
      (e) => now - e.lastSeen < RELAY_CACHE_MAX_AGE_MS,
    );
  } catch {
    return [];
  }
}

function saveCachedRelays(
  appId: string,
  relays: CachedRelay[],
): void {
  if (!hasLocalStorage) return;
  try {
    localStorage.setItem(
      cacheKey(appId),
      JSON.stringify(relays),
    );
  } catch {
    // quota exceeded, etc.
  }
}

function upsertCachedRelay(
  appId: string,
  peerId: string,
  addrs: string[],
): void {
  const relays = loadCachedRelays(appId);
  const existing = relays.find(
    (r) => r.peerId === peerId,
  );
  if (existing) {
    existing.addrs = addrs;
    existing.lastSeen = Date.now();
  } else {
    relays.push({
      peerId,
      addrs,
      lastSeen: Date.now(),
    });
  }
  saveCachedRelays(appId, relays);
}

// --- Discovery ---

export interface RoomDiscovery {
  /** Peer IDs of relays discovered for this app. */
  readonly relayPeerIds: ReadonlySet<string>;
  stop(): void;
}

/**
 * Discover relay nodes by looking up a well-known CID
 * derived from the app ID. Relay nodes provide this CID
 * on the DHT; browsers find them via delegated routing.
 * Once connected, pubsub-peer-discovery (configured in
 * helia.ts) handles browser-to-browser discovery.
 *
 * On startup, tries cached relay addresses from
 * localStorage first (fast direct dial), then runs
 * DHT discovery in parallel to refresh the cache.
 */
export function startRoomDiscovery(
  helia: Helia,
  appId?: string,
): RoomDiscovery {
  let stopped = false;
  let cycleController: AbortController | null = null;
  const relayPeerIds = new Set<string>();

  let running = false;

  async function tagRelay(peerId: any) {
    try {
      await helia.libp2p.peerStore.merge(peerId, {
        tags: {
          "keep-alive": { value: 100 },
        },
      });
    } catch (err) {
      log(
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

  async function dialRelay(
    pid: string,
    wssAddrs: ReturnType<typeof multiaddr>[],
    peerId?: any,
  ): Promise<boolean> {
    const short = pid.slice(-8);
    log(
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
      relayPeerIds.add(pid);
      log(`relay ...${short} OK`);
      return true;
    } catch (err) {
      const e = err as any;
      log(
        `relay ...${short} FAIL:`,
        e.message ?? err,
      );
      if (e.errors) {
        for (const sub of e.errors) {
          log(`  sub-error:`, sub.message ?? sub);
        }
      }
      return false;
    } finally {
      clearTimeout(dialTimer);
    }
  }

  async function dialCachedRelays() {
    if (!appId) return;
    const cached = loadCachedRelays(appId);
    const now = Date.now();
    const fresh = cached.filter(
      (r) => now - r.lastSeen < RELAY_CACHE_TTL_MS,
    );
    if (fresh.length === 0) return;

    log(`trying ${fresh.length} cached relay(s)`);

    for (const entry of fresh) {
      if (stopped) break;

      const pid = entry.peerId;
      const short = pid.slice(-8);
      const already = helia.libp2p
        .getConnections()
        .some(
          (c) => c.remotePeer.toString() === pid,
        );
      if (already) {
        relayPeerIds.add(pid);
        tagRelay(pid);
        log(`cached relay ...${short} (connected)`);
        continue;
      }

      const wssAddrs = extractWssAddrs(
        pid,
        entry.addrs,
      );
      if (wssAddrs.length === 0) continue;

      const ok = await dialRelay(pid, wssAddrs);
      if (ok) {
        tagRelay(pid);
        upsertCachedRelay(
          appId,
          pid,
          entry.addrs,
        );
      }
    }
  }

  async function discoverRelays() {
    if (!appId) return;
    if (running) return; // skip if previous cycle active
    running = true;

    const ctrl = new AbortController();
    cycleController = ctrl;
    const signal = ctrl.signal;

    try {
      const cid = await appIdToCID(appId);
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
          relayPeerIds.add(pid);
          tagRelay(provider.id);
          // Update cache with latest addrs
          const addrs = (
            provider.multiaddrs ?? []
          ).map((ma: any) => ma.toString());
          upsertCachedRelay(appId, pid, addrs);
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

        const wssAddrs = extractWssAddrs(pid, addrs);

        const ok = await dialRelay(
          pid,
          wssAddrs,
          provider.id,
        );
        if (ok) {
          tagRelay(provider.id);
          upsertCachedRelay(appId, pid, addrs);
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
    } finally {
      running = false;
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

  // Try cached relays first (fast), then DHT discovery
  logStatus();
  dialCachedRelays().then(() => {
    if (!stopped) discoverRelays();
  });

  // Periodic re-discovery
  const discoverInterval = setInterval(() => {
    if (!stopped) discoverRelays();
  }, DISCOVERY_INTERVAL_MS);

  // Periodic status logging
  const logInterval = setInterval(() => {
    if (!stopped) logStatus();
  }, LOG_INTERVAL_MS);

  return {
    get relayPeerIds(): ReadonlySet<string> {
      return relayPeerIds;
    },
    stop() {
      stopped = true;
      cycleController?.abort();
      clearInterval(discoverInterval);
      clearInterval(logInterval);
    },
  };
}
