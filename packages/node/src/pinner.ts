import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { code as dagCborCode } from "@ipld/dag-cbor";
import {
  validateStructure,
  decodeSnapshot,
} from "@pokapali/snapshot";
import { hexToBytes } from "@pokapali/crypto";
import {
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
} from "./rate-limiter.js";
import type { RateLimiterConfig } from "./rate-limiter.js";
import { createHistoryTracker } from "./history.js";
import type { HistoryTracker } from "./history.js";
import { loadState, saveState } from "./state.js";
import type { Helia } from "helia";

const log = (...args: unknown[]) =>
  console.error("[pokapali:pinner]", ...args);

const RESOLVE_INTERVAL_MS = 5 * 60_000;
const REPUBLISH_INTERVAL_MS = 60 * 60_000;
const LIBP2P_KEY_CODEC = 0x72;

export interface PinnerConfig {
  appIds: string[];
  rateLimits?: {
    maxPerHour?: number;
    maxSizeBytes?: number;
  };
  storagePath: string;
  maxConnections?: number;
  helia?: Helia;
}

export interface Pinner {
  start(): Promise<void>;
  stop(): Promise<void>;
  ingest(
    ipnsName: string,
    block: Uint8Array,
  ): Promise<boolean>;
  onAnnouncement(
    ipnsName: string,
    cidStr: string,
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
  let resolveInterval: ReturnType<
    typeof setInterval
  > | null = null;
  let republishInterval: ReturnType<
    typeof setInterval
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
        log(
          `invalid block`
          + ` ${ipnsName.slice(0, 12)}...`,
        );
        return false;
      }

      const node = decodeSnapshot(block);
      knownNames.add(ipnsName);
      history.add(ipnsName, cid, node.ts);
      log(
        `fetched block for`
        + ` ${ipnsName.slice(0, 12)}...`
        + ` cid=${cidStr.slice(0, 12)}...`,
      );
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log(
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
      const { ipns } = await import("@helia/ipns");
      const { publicKeyFromRaw } = await import(
        "@libp2p/crypto/keys"
      );
      const name = ipns(helia as any);

      const keyBytes = hexToBytes(ipnsName);
      const pubKey = publicKeyFromRaw(keyBytes);

      const result = await name.resolve(pubKey, {
        signal: AbortSignal.timeout(30_000),
      });
      const cid = result.cid;
      log(
        `resolved ${ipnsName.slice(0, 12)}...`
        + ` -> ${cid.toString().slice(0, 12)}...`,
      );

      return fetchByCid(ipnsName, cid.toString());
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log(
        `resolve failed for`
        + ` ${ipnsName.slice(0, 12)}...: ${msg}`,
      );
      return false;
    }
  }

  async function resolveAll(): Promise<void> {
    const names = [...knownNames];
    if (names.length === 0) return;
    log(`re-resolving ${names.length} names`);
    await Promise.allSettled(
      names.map((n) => resolveAndFetch(n)),
    );
  }

  /**
   * Re-put existing IPNS records to keep them alive
   * on the delegated routing server. No private key
   * needed — records are already signed by writers.
   */
  async function republishAllIPNS(): Promise<void> {
    if (!helia) return;
    const delegated = (helia.libp2p.services as any)
      .delegatedRouting;
    if (!delegated?.getIPNS || !delegated?.putIPNS) {
      return;
    }

    const { publicKeyFromRaw } = await import(
      "@libp2p/crypto/keys"
    );

    const names = [...knownNames];
    if (names.length === 0) return;
    log(`republishing IPNS for ${names.length} names`);

    await Promise.allSettled(
      names.map(async (ipnsName) => {
        try {
          const keyBytes = hexToBytes(ipnsName);
          const pubKey = publicKeyFromRaw(keyBytes);
          const keyCid = CID.createV1(
            LIBP2P_KEY_CODEC,
            pubKey.toMultihash(),
          );
          const record = await delegated.getIPNS(
            keyCid,
            { signal: AbortSignal.timeout(10_000) },
          );
          await delegated.putIPNS(
            keyCid,
            record,
            { signal: AbortSignal.timeout(10_000) },
          );
          log(
            `republished IPNS for`
              + ` ${ipnsName.slice(0, 12)}...`,
          );
        } catch (err) {
          const msg = (err as Error).message ?? "";
          log(
            `IPNS republish failed for`
              + ` ${ipnsName.slice(0, 12)}...:`
              + ` ${msg}`,
          );
        }
      }),
    );
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

    async start(): Promise<void> {
      await restoreState();

      // Resolve all persisted names on startup
      if (helia && knownNames.size > 0) {
        log(
          `startup: resolving`
          + ` ${knownNames.size} persisted names`,
        );
        // Fire and forget — don't block startup
        resolveAll();
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
        // Initial republish after a short delay
        setTimeout(republishAllIPNS, 30_000);
      }
    },

    async stop(): Promise<void> {
      if (resolveInterval) {
        clearInterval(resolveInterval);
      }
      if (republishInterval) {
        clearInterval(republishInterval);
      }
      await persistState();
    },

    onAnnouncement(
      ipnsName: string,
      cidStr: string,
    ): void {
      knownNames.add(ipnsName);
      log(
        `announcement: name=${ipnsName.slice(0, 12)}...`
        + ` cid=${cidStr.slice(0, 12)}...`,
      );
      // Fetch the announced CID directly (don't
      // re-resolve IPNS — the announcement has the
      // latest CID, IPNS may lag behind).
      if (helia) {
        fetchByCid(ipnsName, cidStr);
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

