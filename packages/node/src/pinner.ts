import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { code as dagCborCode } from "@ipld/dag-cbor";
import {
  validateStructure,
  decodeSnapshot,
} from "@pokapali/snapshot";
import { hexToBytes } from "@pokapali/crypto";
import { ipns } from "@helia/ipns";
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import {
  announceAck,
} from "@pokapali/core/announce";
import type {
  AnnouncePubSub,
} from "@pokapali/core/announce";
import {
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
} from "./rate-limiter.js";
import type { RateLimiterConfig } from "./rate-limiter.js";
import { createHistoryTracker } from "./history.js";
import type { HistoryTracker } from "./history.js";
import { loadState, saveState } from "./state.js";
import { createLogger } from "@pokapali/log";
import type { Helia } from "helia";

const log = createLogger("pinner");

const RESOLVE_INTERVAL_MS = 5 * 60_000;
const REPUBLISH_INTERVAL_MS = 4 * 60 * 60_000;
const REPUBLISH_PER_NAME_DELAY_MS = 5_000;
const REPUBLISH_TIMEOUT_MS = 15_000;

export interface PinnerConfig {
  appIds: string[];
  rateLimits?: {
    maxPerHour?: number;
    maxSizeBytes?: number;
  };
  storagePath: string;
  maxConnections?: number;
  helia?: Helia;
  /** PubSub for publishing ack messages. */
  pubsub?: AnnouncePubSub;
  /** Stable peer ID for ack attribution. */
  peerId?: string;
}

export interface Pinner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Await all pending background work. */
  flush(): Promise<void>;
  ingest(
    ipnsName: string,
    block: Uint8Array,
  ): Promise<boolean>;
  onAnnouncement(
    ipnsName: string,
    cidStr: string,
    appId?: string,
    blockData?: Uint8Array,
  ): void;
  history: HistoryTracker;
}

export async function createPinner(
  config: PinnerConfig,
): Promise<Pinner> {
  const rateLimits: RateLimiterConfig = {
    maxSnapshotsPerHour:
      config.rateLimits?.maxPerHour ??
      DEFAULT_RATE_LIMITS.maxSnapshotsPerHour,
    maxBlockSizeBytes:
      config.rateLimits?.maxSizeBytes ??
      DEFAULT_RATE_LIMITS.maxBlockSizeBytes,
  };
  const rateLimiter = createRateLimiter(rateLimits);
  const history = createHistoryTracker();
  const statePath =
    config.storagePath + "/state.json";
  const helia = config.helia;

  // In-memory block store as fallback when no Helia
  const memBlocks = new Map<string, Uint8Array>();
  const knownNames = new Set<string>();
  // Track last acked CID per ipnsName to avoid
  // redundant fetch+ack cycles on re-announces.
  const lastAckedCid = new Map<string, string>();
  // Track fire-and-forget async work so tests (and
  // graceful shutdown) can await completion.
  const pending = new Set<Promise<unknown>>();
  function track(p: Promise<unknown>): void {
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  let stopped = false;
  let resolveInterval: ReturnType<
    typeof setInterval
  > | null = null;
  let republishInterval: ReturnType<
    typeof setInterval
  > | null = null;
  let initialRepublishTimer: ReturnType<
    typeof setTimeout
  > | null = null;

  async function storeBlock(
    cid: CID,
    block: Uint8Array,
  ): Promise<void> {
    if (helia) {
      await helia.blockstore.put(cid, block);
    } else {
      memBlocks.set(cid.toString(), block);
    }
  }

  /**
   * Fetch a block by CID directly (no IPNS resolve).
   * Used when we already know the CID from an
   * announcement.
   */
  async function fetchByCid(
    ipnsName: string,
    cidStr: string,
  ): Promise<boolean> {
    if (!helia) return false;

    try {
      const tipCid = history.getTip(ipnsName);
      if (tipCid === cidStr) {
        return true; // Already have latest
      }

      const cid = CID.parse(cidStr);
      const block = await helia.blockstore.get(cid, {
        signal: AbortSignal.timeout(30_000),
      });

      const valid = await validateStructure(block);
      if (!valid) {
        log.warn(
          `invalid block`
          + ` ${ipnsName.slice(0, 12)}...`,
        );
        return false;
      }

      const node = decodeSnapshot(block);
      knownNames.add(ipnsName);
      history.add(ipnsName, cid, node.ts);
      log.debug(
        `fetched block for`
        + ` ${ipnsName.slice(0, 12)}...`
        + ` cid=${cidStr.slice(0, 12)}...`,
      );
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log.error(
        `fetch failed for`
        + ` ${ipnsName.slice(0, 12)}...`
        + ` cid=${cidStr.slice(0, 12)}...: ${msg}`,
      );
      return false;
    }
  }

  /**
   * Resolve IPNS name and fetch the block. Used for
   * periodic re-resolution and startup recovery.
   */
  async function resolveAndFetch(
    ipnsName: string,
  ): Promise<boolean> {
    if (!helia) return false;

    try {
      const name = ipns(helia as any);
      const keyBytes = hexToBytes(ipnsName);
      const pubKey = publicKeyFromRaw(keyBytes);

      const result = await name.resolve(pubKey, {
        signal: AbortSignal.timeout(30_000),
      });
      const cid = result.cid;
      log.debug(
        `resolved ${ipnsName.slice(0, 12)}...`
        + ` -> ${cid.toString().slice(0, 12)}...`,
      );

      return fetchByCid(ipnsName, cid.toString());
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log.error(
        `resolve failed for`
        + ` ${ipnsName.slice(0, 12)}...: ${msg}`,
      );
      return false;
    }
  }

  async function resolveAll(): Promise<void> {
    const names = [...knownNames];
    if (names.length === 0) return;
    log.debug(`re-resolving ${names.length} names`);
    await Promise.allSettled(
      names.map((n) => resolveAndFetch(n)),
    );
  }

  /**
   * Re-put existing IPNS records to keep them alive
   * on the DHT. No private key needed — records are
   * already signed by writers. Uses @helia/ipns
   * republishRecord which goes through Helia's
   * composed routing (DHT on node side).
   */
  async function republishAllIPNS(): Promise<void> {
    if (!helia) return;

    const name = ipns(helia as any);
    const names = [...knownNames];
    if (names.length === 0) return;
    log.debug(`republishing IPNS for ${names.length} names`);

    for (const ipnsName of names) {
      if (stopped) break;
      try {
        const keyBytes = hexToBytes(ipnsName);
        const pubKey = publicKeyFromRaw(keyBytes);

        // Resolve to get the current record
        const result = await name.resolve(pubKey, {
          signal: AbortSignal.timeout(
            REPUBLISH_TIMEOUT_MS,
          ),
        });

        // Republish without private key
        await name.republishRecord(
          pubKey.toMultihash(),
          result.record,
          {
            signal: AbortSignal.timeout(
              REPUBLISH_TIMEOUT_MS,
            ),
          },
        );
        log.debug(
          `republished IPNS for`
            + ` ${ipnsName.slice(0, 12)}...`,
        );
      } catch (err) {
        const msg = (err as Error).message ?? "";
        log.error(
          `IPNS republish failed for`
            + ` ${ipnsName.slice(0, 12)}...:`
            + ` ${msg}`,
        );
      }
      // Spread out DHT work so it doesn't compete
      // with relay coordination.
      if (!stopped) {
        await new Promise((r) =>
          setTimeout(r, REPUBLISH_PER_NAME_DELAY_MS),
        );
      }
    }
  }

  async function restoreState(): Promise<void> {
    const state = await loadState(statePath);
    for (const n of state.knownNames) {
      knownNames.add(n);
    }
  }

  async function persistState(): Promise<void> {
    const tips: Record<string, string> = {};
    for (const name of knownNames) {
      const tip = history.getTip(name);
      if (tip) tips[name] = tip;
    }
    await saveState(statePath, {
      knownNames: [...knownNames],
      tips,
    });
  }

  return {
    history,

    async flush(): Promise<void> {
      await Promise.allSettled([...pending]);
    },

    async start(): Promise<void> {
      await restoreState();

      // Resolve all persisted names on startup
      if (helia && knownNames.size > 0) {
        log.info(
          `startup: resolving`
          + ` ${knownNames.size} persisted names`,
        );
        // Fire and forget — don't block startup
        track(resolveAll());
      }

      // Periodic re-resolve
      if (helia) {
        resolveInterval = setInterval(
          resolveAll,
          RESOLVE_INTERVAL_MS,
        );
        // Periodic IPNS republish (keeps records
        // alive when writers are offline)
        republishInterval = setInterval(
          republishAllIPNS,
          REPUBLISH_INTERVAL_MS,
        );
        // Initial republish after startup settles
        initialRepublishTimer = setTimeout(() => {
          track(republishAllIPNS());
        }, 5 * 60_000);
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      if (resolveInterval) {
        clearInterval(resolveInterval);
      }
      if (republishInterval) {
        clearInterval(republishInterval);
      }
      if (initialRepublishTimer) {
        clearTimeout(initialRepublishTimer);
      }
      await persistState();
    },

    onAnnouncement(
      ipnsName: string,
      cidStr: string,
      appId?: string,
      blockData?: Uint8Array,
    ): void {
      knownNames.add(ipnsName);

      // If block data is included, store it so
      // fetchByCid can find it locally.
      if (blockData && helia) {
        try {
          const cid = CID.parse(cidStr);
          track(
            Promise.resolve(
              helia.blockstore.put(cid, blockData),
            ).catch((err) => {
              log.warn(
                "blockstore.put from announce:",
                err,
              );
            }),
          );
        } catch (err) {
          log.warn("CID parse failed:", err);
        }
      }

      // Dedup: if we already fetched+acked this CID,
      // just re-ack (cheap) so new browsers see it.
      if (lastAckedCid.get(ipnsName) === cidStr) {
        log.debug(
          `duplicate: ${cidStr.slice(0, 12)}...`
          + ` re-acking`,
        );
        if (
          appId &&
          config.pubsub &&
          config.peerId
        ) {
          track(
            announceAck(
              config.pubsub,
              appId,
              ipnsName,
              cidStr,
              config.peerId,
            ).catch((err) => {
              log.warn("re-ack failed:", err);
            }),
          );
        }
        return;
      }

      log.debug(
        `announcement: name=${ipnsName.slice(0, 12)}...`
        + ` cid=${cidStr.slice(0, 12)}...`,
      );
      // Fetch the announced CID directly (don't
      // re-resolve IPNS — the announcement has the
      // latest CID, IPNS may lag behind).
      if (helia) {
        track(
          fetchByCid(ipnsName, cidStr).then(
            async (ok) => {
              if (
                ok &&
                appId &&
                config.pubsub &&
                config.peerId
              ) {
                await announceAck(
                  config.pubsub,
                  appId,
                  ipnsName,
                  cidStr,
                  config.peerId,
                );
                lastAckedCid.set(
                  ipnsName, cidStr,
                );
                log.debug(
                  `acked`
                  + ` ${ipnsName.slice(0, 12)}...`
                  + ` cid=${cidStr.slice(0, 12)}...`,
                );
              } else {
                log.debug(
                  `ack skipped:`
                  + ` ok=${ok}`
                  + ` appId=${appId}`
                  + ` pubsub=${!!config.pubsub}`
                  + ` peerId=${!!config.peerId}`,
                );
              }
            },
          ).catch((err) => {
            log.warn(
              `ack failed:`
              + ` ${ipnsName.slice(0, 12)}...`
              + ` cid=${cidStr.slice(0, 12)}...:`,
              err,
            );
          }),
        );
      }
    },

    async ingest(
      ipnsName: string,
      block: Uint8Array,
    ): Promise<boolean> {
      // Rate limit: block size
      const check = rateLimiter.check(
        ipnsName,
        block.byteLength,
      );
      if (!check.allowed) {
        return false;
      }

      // Structural validation
      const valid = await validateStructure(block);
      if (!valid) {
        return false;
      }

      // Compute CID for storage
      const hash = await sha256.digest(block);
      const cid = CID.create(1, dagCborCode, hash);

      // Decode to get timestamp
      const node = decodeSnapshot(block);

      // Store block
      await storeBlock(cid, block);
      knownNames.add(ipnsName);
      rateLimiter.record(ipnsName);
      history.add(ipnsName, cid, node.ts);

      return true;
    },
  };
}

