import { createHelia, libp2pDefaults } from "helia";
import { ipns } from "@helia/ipns";
import { pubsub as ipnsPubsub } from "@helia/ipns/routing";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { CID } from "multiformats/cid";
import {
  validateStructure,
  decodeSnapshot,
} from "@pokapali/snapshot";
import {
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
} from "./rate-limiter.js";
import type { RateLimiterConfig } from "./rate-limiter.js";
import { createHistoryTracker } from "./history.js";
import { loadState, saveState } from "./state.js";

import type { Helia } from "helia";
import type { IPNS } from "@helia/ipns";
import type { Libp2p, PubSub } from "@libp2p/interface";
import type {
  MultihashDigest,
} from "multiformats/hashes/interface";

type IpnsMultihash = MultihashDigest<0x00 | 0x12>;

export interface PinnerConfig {
  appIds: string[];
  rateLimits?: Partial<RateLimiterConfig>;
  storagePath: string;
  maxConnections?: number;
}

interface PinnerNode {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// 12 hours in ms
const REPUBLISH_INTERVAL = 12 * 60 * 60 * 1000;
// 1 hour pruning interval
const PRUNE_INTERVAL = 60 * 60 * 1000;
// 5 minutes state save interval
const SAVE_INTERVAL = 5 * 60 * 1000;

export async function createPinner(
  config: PinnerConfig
): Promise<PinnerNode> {
  const rateLimits: RateLimiterConfig = {
    ...DEFAULT_RATE_LIMITS,
    ...config.rateLimits,
  };
  const rateLimiter = createRateLimiter(rateLimits);
  const history = createHistoryTracker();
  const statePath = config.storagePath + "/state.json";

  let helia: Helia | null = null;
  let name: IPNS | null = null;
  let pruneTimer: ReturnType<typeof setInterval> |
    null = null;
  let saveTimer: ReturnType<typeof setInterval> |
    null = null;
  let republishTimer: ReturnType<typeof setInterval> |
    null = null;
  let stopped = false;

  const discoveredNames = new Set<string>();

  async function initHelia(): Promise<void> {
    const libp2pOptions = libp2pDefaults();
    libp2pOptions.services.pubsub = gossipsub();
    if (config.maxConnections) {
      libp2pOptions.connectionManager = {
        ...libp2pOptions.connectionManager,
        maxConnections: config.maxConnections,
      };
    }

    helia = await createHelia({
      libp2p: libp2pOptions,
    });

    const heliaWithPubsub = helia as Helia<
      Libp2p<{ pubsub: PubSub }>
    >;
    name = ipns(helia, {
      routers: [ipnsPubsub(heliaWithPubsub)],
    });
  }

  async function ingestSnapshot(
    ipnsName: string,
    cid: CID,
    block: Uint8Array
  ): Promise<boolean> {
    const check = rateLimiter.check(
      ipnsName, block.byteLength
    );
    if (!check.allowed) {
      console.error(
        `[pinner] rate limited ${ipnsName}:`
          + ` ${check.reason}`
      );
      return false;
    }

    const valid = await validateStructure(block);
    if (!valid) {
      console.error(
        `[pinner] invalid snapshot for ${ipnsName}`
      );
      return false;
    }

    const node = decodeSnapshot(block);

    await helia!.blockstore.put(cid, block);
    for await (const _ of helia!.pins.add(cid)) {
      // drain the async generator
    }

    rateLimiter.record(ipnsName);
    history.add(ipnsName, cid, node.ts);

    console.log(
      `[pinner] pinned ${cid} for ${ipnsName}`
    );
    return true;
  }

  async function resolveAndIngest(
    ipnsName: string
  ): Promise<void> {
    if (!name || !helia || stopped) return;

    try {
      const nameCid = CID.parse(ipnsName);
      const mh = nameCid.multihash as IpnsMultihash;
      const result = await name.resolve(mh, {
        signal: AbortSignal.timeout(30_000),
      });
      const cid = result.cid;

      const isPinned = await helia.pins.isPinned(cid);
      if (isPinned) return;

      const block = await helia.blockstore.get(cid, {
        signal: AbortSignal.timeout(30_000),
      });

      await ingestSnapshot(ipnsName, cid, block);
    } catch (err) {
      if (!stopped) {
        console.error(
          `[pinner] resolve failed for`
            + ` ${ipnsName}:`,
          err
        );
      }
    }
  }

  function subscribeToAppTopics(): void {
    if (!helia) return;

    const pubsub = (
      helia.libp2p as Libp2p<{ pubsub: PubSub }>
    ).services.pubsub;

    for (const appId of config.appIds) {
      const topic = `/app/${appId}/announce`;
      pubsub.subscribe(topic);
      console.log(
        `[pinner] subscribed to ${topic}`
      );
    }

    pubsub.addEventListener("message", (evt) => {
      const msg = evt.detail;
      const isAnnounceTopic = config.appIds.some(
        (id) => msg.topic === `/app/${id}/announce`
      );
      if (!isAnnounceTopic) return;

      try {
        const ipnsName = new TextDecoder().decode(
          msg.data
        );
        if (!discoveredNames.has(ipnsName)) {
          console.log(
            `[pinner] discovered ${ipnsName}`
              + ` via ${msg.topic}`
          );
          discoveredNames.add(ipnsName);
          resolveAndIngest(ipnsName);
        }
      } catch (err) {
        console.error(
          "[pinner] malformed announce:", err
        );
      }
    });
  }

  async function republishRecords(): Promise<void> {
    if (!name || !helia || stopped) return;

    for (const ipnsName of discoveredNames) {
      if (stopped) break;
      try {
        const nameCid = CID.parse(ipnsName);
        const mh = nameCid.multihash as IpnsMultihash;
        const result = await name.resolve(mh, {
          offline: true,
          signal: AbortSignal.timeout(5_000),
        });
        await name.republishRecord(
          mh,
          result.record,
          { signal: AbortSignal.timeout(30_000) }
        );
        console.log(
          `[pinner] republished ${ipnsName}`
        );
      } catch (err) {
        if (!stopped) {
          console.error(
            `[pinner] republish failed`
              + ` for ${ipnsName}:`,
            err
          );
        }
      }
    }
  }

  async function pruneOldSnapshots(): Promise<void> {
    if (!helia || stopped) return;

    const removed = history.prune();
    for (const cid of removed) {
      try {
        for await (const _ of helia.pins.rm(cid)) {
          // drain
        }
        console.log(
          `[pinner] unpinned expired ${cid}`
        );
      } catch {
        // already unpinned
      }
    }
  }

  async function persistState(): Promise<void> {
    await saveState(statePath, {
      discoveredNames: [...discoveredNames],
      history: history.toJSON(),
    });
  }

  async function restoreState(): Promise<void> {
    const state = await loadState(statePath);
    for (const n of state.discoveredNames) {
      discoveredNames.add(n);
    }
    history.loadJSON(state.history);
  }

  return {
    async start(): Promise<void> {
      await restoreState();
      await initHelia();
      subscribeToAppTopics();

      for (const n of discoveredNames) {
        resolveAndIngest(n);
      }

      pruneTimer = setInterval(
        () => { pruneOldSnapshots(); },
        PRUNE_INTERVAL
      );
      saveTimer = setInterval(
        () => { persistState(); },
        SAVE_INTERVAL
      );
      republishTimer = setInterval(
        () => { republishRecords(); },
        REPUBLISH_INTERVAL
      );

      console.log(
        `[pinner] started for appIds:`
          + ` ${config.appIds.join(", ")}`
      );
    },

    async stop(): Promise<void> {
      stopped = true;

      if (pruneTimer) clearInterval(pruneTimer);
      if (saveTimer) clearInterval(saveTimer);
      if (republishTimer) {
        clearInterval(republishTimer);
      }

      await persistState();

      if (helia) {
        await helia.stop();
        helia = null;
      }

      console.log("[pinner] stopped");
    },
  };
}
