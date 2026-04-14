import type { Helia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createLogger } from "@pokapali/log";
import { loadCachedRelays, upsertCachedRelay } from "./relay-cache.js";
import { createThrottledInterval } from "./throttled-interval.js";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 30_000;
const FIND_TIMEOUT_MS = 30_000;
const DIAL_TIMEOUT_MS = 10_000;
const LOG_INTERVAL_MS = 15_000;
const RELAY_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h
const RECONNECT_BASE_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 120_000;
// Only reset backoff after connection holds this long.
// Prevents reconnect loops: reconnect → immediate
// disconnect → backoff resets → 5s loop.
const STABILITY_WINDOW_MS = 30_000;
// Tag value for relay peers. Protects from connection
// pruning (pruner drops lowest-value peers first)
// without using KEEP_ALIVE (which triggers libp2p's
// ReconnectQueue and causes a dual-reconnection race).
const RELAY_TAG = "pokapali-relay";
const RELAY_TAG_VALUE = 100;

const log = createLogger("discovery");

async function networkCID(): Promise<CID> {
  const bytes = new TextEncoder().encode("pokapali-network");
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
    .map((s) => multiaddr(s.includes("/p2p/") ? s : s + p2pSuffix));
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
  /** Resolves when at least one relay is connected,
   *  or rejects after timeoutMs. */
  waitForRelay(timeoutMs: number): Promise<string>;
  /** Fires when a previously-disconnected relay
   *  is successfully redialed. */
  onRelayReconnected(cb: (relayPid: string) => void): () => void;
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
  const reconnectCbs = new Set<(relayPid: string) => void>();

  let running = false;

  // Waiters for first relay connection
  const relayWaiters: Array<(pid: string) => void> = [];

  const secure =
    typeof globalThis.location !== "undefined" &&
    globalThis.location.protocol === "https:";

  function wssAddrs(pid: string, rawAddrs: string[]) {
    return extractWssAddrs(pid, rawAddrs, secure);
  }

  async function tagRelay(pid: string) {
    const conn = helia.libp2p
      .getConnections()
      .find((c) => c.remotePeer.toString() === pid);
    if (!conn) return;
    try {
      await helia.libp2p.peerStore.merge(conn.remotePeer, {
        tags: {
          [RELAY_TAG]: { value: RELAY_TAG_VALUE },
        },
      });
    } catch (err) {
      log.debug("tag relay failed:", (err as Error)?.message ?? err);
    }
  }

  function untagRelay(pid: string) {
    const conn = helia.libp2p
      .getConnections()
      .find((c) => c.remotePeer.toString() === pid);
    if (!conn) return;
    helia.libp2p.peerStore
      .merge(conn.remotePeer, {
        tags: { [RELAY_TAG]: undefined },
      })
      .catch((err) => {
        log.debug("untag relay failed:", (err as Error)?.message ?? err);
      });
  }

  async function trackRelay(pid: string, addrs: string[]) {
    const isNew = !relayPeerIds.has(pid);
    relayPeerIds.add(pid);
    relayAddrs.set(pid, addrs);
    // Resolve waiters immediately — the relay is
    // connected (dial succeeded). Waiting for the tag
    // risks hanging if peerStore.merge stalls (e.g.
    // IDB transaction stuck in a background tab).
    if (isNew && relayWaiters.length > 0) {
      for (const resolve of relayWaiters.splice(0)) {
        resolve(pid);
      }
    }
    // Tag after waiter resolution. Still awaited so
    // the caller knows pruning protection is applied
    // before returning.
    await tagRelay(pid);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    peerId?: any,
  ): Promise<boolean> {
    const short = pid.slice(-8);
    log.debug(
      `relay ...${short}, dialing...`,
      wssAddrs.map((ma) => ma.toString()),
    );
    const dialCtrl = new AbortController();
    const dialTimer = setTimeout(() => dialCtrl.abort(), DIAL_TIMEOUT_MS);
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
      await trackRelay(pid, rawAddrs);
      log.info(`relay ...${short} OK`);
      return true;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      log.debug(`relay ...${short} FAIL:`, e.message ?? err);
      if (e.errors) {
        for (const sub of e.errors) {
          log.debug(`  sub-error:`, sub.message ?? sub);
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
    const fresh = cached.filter((r) => now - r.lastSeen < RELAY_CACHE_TTL_MS);
    if (fresh.length === 0) return;

    log.debug(`trying ${fresh.length} cached relay(s)`);

    await Promise.all(
      fresh.map(async (entry) => {
        if (stopped) return;

        const pid = entry.peerId;
        const short = pid.slice(-8);
        const already = helia.libp2p
          .getConnections()
          .some((c) => c.remotePeer.toString() === pid);
        if (already) {
          await trackRelay(pid, entry.addrs);
          log.debug(`cached relay ...${short} (connected)`);
          return;
        }

        const dialAddrs = wssAddrs(pid, entry.addrs);
        if (dialAddrs.length === 0) return;

        const ok = await dialRelay(pid, dialAddrs, entry.addrs);
        if (ok) {
          upsertCachedRelay(pid, entry.addrs);
        }
        // Don't evict on failure — the 24h TTL in
        // loadCachedRelays handles natural expiry.
      }),
    );
  }

  interface ProviderToDial {
    pid: string;
    filtered: ReturnType<typeof multiaddr>[];
    addrs: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const startMs = Date.now();
      log.info("findProviders starting", "cid:", cid.toString());
      const timeout = setTimeout(() => {
        log.info(
          "findProviders timeout fired",
          `after ${FIND_TIMEOUT_MS}ms,`,
          `found so far: ${found}`,
        );
        ctrl.abort();
      }, FIND_TIMEOUT_MS);

      // Phase 1: collect providers from iterator
      // (bounded by FIND_TIMEOUT_MS). Slow dials no
      // longer block iteration.
      const toDial: ProviderToDial[] = [];
      let found = 0;
      for await (const provider of helia.routing.findProviders(cid, {
        signal,
      })) {
        if (signal.aborted) break;
        found++;

        const pid = provider.id.toString();
        const short = pid.slice(-8);
        const already = helia.libp2p
          .getConnections()
          .some((c) => c.remotePeer.toString() === pid);

        const addrs =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          provider.multiaddrs?.map((ma: any) => ma.toString()) ?? [];

        log.info(
          `provider #${found}: ...${short}`,
          `addrs: ${addrs.length},`,
          already ? "(already connected)" : "(new)",
        );
        log.debug(
          `  addrs:`,
          addrs.slice(0, 5).join(", "),
          addrs.length > 5 ? `(+${addrs.length - 5} more)` : "",
        );

        if (already) {
          await trackRelay(pid, addrs);
          upsertCachedRelay(pid, addrs);
          continue;
        }

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
          log.info(
            `provider ...${short} skipped`,
            "(no browser-dialable addrs)",
          );
          continue;
        }

        const filtered = wssAddrs(pid, addrs);
        log.debug(
          `  dialable:`,
          filtered.map((ma) => ma.toString()).join(", "),
        );
        toDial.push({
          pid,
          filtered,
          addrs,
          peerId: provider.id,
        });
      }

      clearTimeout(timeout);
      const elapsed = Date.now() - startMs;
      log.info(
        `findProviders done:`,
        `${found} provider(s) in ${elapsed}ms,`,
        `${toDial.length} to dial`,
      );

      // Phase 2: dial all collected providers in
      // parallel (each with its own DIAL_TIMEOUT).
      if (toDial.length > 0) {
        await Promise.allSettled(
          toDial.map(async (p) => {
            const ok = await dialRelay(p.pid, p.filtered, p.addrs, p.peerId);
            if (ok) {
              upsertCachedRelay(p.pid, p.addrs);
            }
          }),
        );
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("abort")) {
        // Expected when cycle is cancelled.
      } else if (msg.includes("not started")) {
        // Benign: DHT QueryManager hasn't initialized
        // yet. Will succeed on next discovery cycle.
        log.debug(`discovery: ${msg}`);
      } else {
        log.warn(`discovery error: ${msg}`);
      }
    } finally {
      running = false;
    }
  }

  function logStatus() {
    const peers = helia.libp2p.getPeers();
    const addrs = helia.libp2p.getMultiaddrs();
    const connectedCount = [...relayPeerIds].filter((pid) =>
      helia.libp2p
        .getConnections()
        .some((c) => c.remotePeer.toString() === pid),
    ).length;
    log.info(
      `${relayPeerIds.size} relays tracked,`,
      `${connectedCount} connected,`,
      `${peers.length} total peers`,
    );
    log.debug(`${addrs.length} listening addrs`);
  }

  // --- Relay reconnection on disconnect ---
  //
  // We tag relays (not KEEP_ALIVE) for pruning
  // protection. Our own handler manages reconnection
  // with exponential backoff capped at 120s. Retries
  // indefinitely — relays stay in relayPeerIds so
  // they remain visible in diagnostics and relay
  // sharing.

  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  // Stability timers: after a successful reconnect,
  // only reset the attempt counter once the connection
  // holds for STABILITY_WINDOW_MS. Prevents loops
  // where reconnect succeeds but drops immediately,
  // resetting backoff to 5s each time.
  const stabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const disconnectHandler = (evt: CustomEvent) => {
    const peerId = evt.detail;
    const pid = peerId.toString();
    if (!relayPeerIds.has(pid)) return;
    const short = pid.slice(-8);

    // Cancel stability timer — connection didn't hold.
    const stab = stabilityTimers.get(pid);
    if (stab) {
      clearTimeout(stab);
      stabilityTimers.delete(pid);
    }

    // Cancel any pending redial for this peer.
    const existing = reconnectTimers.get(pid);
    if (existing) clearTimeout(existing);

    if (stopped) return;

    // Liveness check: if other connections to this peer
    // still exist, skip reconnect scheduling.
    const stillConnected = helia.libp2p
      .getConnections()
      .some((c) => c.remotePeer.toString() === pid);
    if (stillConnected) {
      log.debug(
        `relay ...${short} disconnect event,`,
        `but still connected — skipping redial`,
      );
      return;
    }

    const attempts = reconnectAttempts.get(pid) ?? 0;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts),
      MAX_RECONNECT_DELAY_MS,
    );
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

        const cached = loadCachedRelays().find((r) => r.peerId === pid);
        if (!cached) {
          untrackRelay(pid);
          return;
        }

        const redialAddrs = wssAddrs(pid, cached.addrs);
        if (redialAddrs.length === 0) {
          untrackRelay(pid);
          return;
        }

        const ok = await dialRelay(pid, redialAddrs, cached.addrs);
        if (ok) {
          // Don't reset attempts immediately — wait for
          // the connection to prove stable. If it drops
          // within STABILITY_WINDOW_MS, backoff stays.
          reconnectAttempts.set(pid, attempts + 1);
          stabilityTimers.set(
            pid,
            setTimeout(() => {
              reconnectAttempts.delete(pid);
              stabilityTimers.delete(pid);
            }, STABILITY_WINDOW_MS),
          );
          upsertCachedRelay(pid, cached.addrs);
          log.info(`relay ...${short} reconnected`);
          for (const cb of reconnectCbs) {
            try {
              cb(pid);
            } catch (err) {
              log.debug("reconnect cb error:", (err as Error)?.message ?? err);
            }
          }
        } else {
          reconnectAttempts.set(pid, attempts + 1);
        }
      }, delay),
    );
  };

  helia.libp2p.addEventListener("peer:disconnect", disconnectHandler);

  // Try cached relays and DHT discovery concurrently.
  // Cache dials are fast; DHT is slow. No reason to wait.
  logStatus();
  dialCachedRelays();
  discoverRelays();

  // Second startup discovery after 15s — DHT may
  // return different providers on a fresh query.
  const secondDiscoveryTimer = setTimeout(() => {
    if (!stopped) discoverRelays();
  }, 15_000);

  // Periodic re-discovery — paused when hidden.
  const discoverInterval = createThrottledInterval(
    () => {
      if (!stopped) discoverRelays();
    },
    DISCOVERY_INTERVAL_MS,
    { backgroundMs: 0, fireOnResume: true },
  );

  // Periodic status logging
  const logInterval = setInterval(() => {
    if (!stopped) logStatus();
  }, LOG_INTERVAL_MS);

  async function addExternalRelays(entries: RelayEntry[]) {
    for (const entry of entries) {
      if (stopped) break;

      const pid = entry.peerId;
      const short = pid.slice(-8);
      const connected = helia.libp2p
        .getConnections()
        .some((c) => c.remotePeer.toString() === pid);

      if (connected) {
        await trackRelay(pid, entry.addrs);
        log.debug(`peer-shared relay ...${short}`, `(connected)`);
        upsertCachedRelay(pid, entry.addrs);
        continue;
      }

      // Skip if actively reconnecting (has a
      // pending reconnect timer).
      if (reconnectTimers.has(pid)) continue;

      const extAddrs = wssAddrs(pid, entry.addrs);
      if (extAddrs.length === 0) continue;

      log.debug(`peer-shared relay ...${short}`);
      const ok = await dialRelay(pid, extAddrs, entry.addrs);
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
      return [...relayAddrs.entries()].map(([peerId, addrs]) => ({
        peerId,
        addrs,
      }));
    },
    addExternalRelays(entries: RelayEntry[]) {
      addExternalRelays(entries);
    },
    waitForRelay(timeoutMs: number): Promise<string> {
      // Already have a relay — resolve immediately
      if (relayPeerIds.size > 0) {
        const first = relayPeerIds.values().next().value!;
        return Promise.resolve(first);
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = relayWaiters.indexOf(resolve);
          if (idx >= 0) relayWaiters.splice(idx, 1);
          reject(new Error("No relay found within " + `${timeoutMs}ms`));
        }, timeoutMs);
        relayWaiters.push((pid: string) => {
          clearTimeout(timer);
          resolve(pid);
        });
      });
    },
    onRelayReconnected(cb: (relayPid: string) => void): () => void {
      reconnectCbs.add(cb);
      return () => reconnectCbs.delete(cb);
    },
    stop() {
      stopped = true;
      cycleController?.abort();
      clearTimeout(secondDiscoveryTimer);
      discoverInterval.destroy();
      clearInterval(logInterval);
      for (const timer of reconnectTimers.values()) {
        clearTimeout(timer);
      }
      reconnectTimers.clear();
      for (const timer of stabilityTimers.values()) {
        clearTimeout(timer);
      }
      stabilityTimers.clear();
      reconnectAttempts.clear();
      reconnectCbs.clear();
      helia.libp2p.removeEventListener("peer:disconnect", disconnectHandler);
    },
  };
}
