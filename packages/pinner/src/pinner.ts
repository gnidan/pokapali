import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { code as dagCborCode } from "@ipld/dag-cbor";
import { validateStructure, decodeSnapshot } from "@pokapali/snapshot";
import { createRateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter.js";
import type { RateLimiterConfig } from "./rate-limiter.js";
import { createHistoryTracker } from "./history.js";
import type { HistoryTracker } from "./history.js";
import { loadState, saveState } from "./state.js";

export interface PinnerConfig {
  appIds: string[];
  rateLimits?: {
    maxPerHour?: number;
    maxSizeBytes?: number;
  };
  storagePath: string;
  maxConnections?: number;
}

export interface Pinner {
  start(): Promise<void>;
  stop(): Promise<void>;
  ingest(ipnsName: string, block: Uint8Array): Promise<boolean>;
  history: HistoryTracker;
}

export async function createPinner(config: PinnerConfig): Promise<Pinner> {
  const rateLimits: RateLimiterConfig = {
    maxSnapshotsPerHour:
      config.rateLimits?.maxPerHour ?? DEFAULT_RATE_LIMITS.maxSnapshotsPerHour,
    maxBlockSizeBytes:
      config.rateLimits?.maxSizeBytes ?? DEFAULT_RATE_LIMITS.maxBlockSizeBytes,
  };
  const rateLimiter = createRateLimiter(rateLimits);
  const history = createHistoryTracker();
  const statePath = config.storagePath + "/state.json";

  // In-memory block store (real version uses Helia)
  const blocks = new Map<string, Uint8Array>();
  const knownNames = new Set<string>();

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
    },

    async stop(): Promise<void> {
      await persistState();
    },

    async ingest(ipnsName: string, block: Uint8Array): Promise<boolean> {
      // Rate limit: block size
      const check = rateLimiter.check(ipnsName, block.byteLength);
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
      blocks.set(cid.toString(), block);
      knownNames.add(ipnsName);
      rateLimiter.record(ipnsName);
      history.add(ipnsName, cid, node.ts);

      return true;
    },
  };
}
