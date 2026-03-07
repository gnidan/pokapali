import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import {
  pubsubPeerDiscovery,
} from "@libp2p/pubsub-peer-discovery";
import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DISCOVERY_TOPIC =
  "pokapali._peer-discovery._p2p._pubsub";
const RAW_CODEC = 0x55;
const PROVIDE_INTERVAL_MS = 5 * 60_000;
const LOG_INTERVAL_MS = 30_000;

const log = (...args: unknown[]) =>
  console.error("[pokapali:relay]", ...args);

async function appIdToCID(
  appId: string,
): Promise<CID> {
  const bytes = new TextEncoder().encode(
    "pokapali-relay:" + appId,
  );
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

export interface RelayConfig {
  appIds: string[];
}

export interface Relay {
  stop(): Promise<void>;
  multiaddrs(): string[];
  peerId(): string;
}

export async function startRelay(
  config: RelayConfig,
): Promise<Relay> {
  const defaults = libp2pDefaults();

  const helia = await createHelia({
    libp2p: {
      ...defaults,
      peerDiscovery: [
        ...(defaults.peerDiscovery ?? []),
        pubsubPeerDiscovery({
          interval: 10_000,
          topics: [DISCOVERY_TOPIC],
        }),
      ],
      services: {
        ...defaults.services,
        pubsub: gossipsub(),
      },
    },
  }) as Helia;

  // Subscribe to discovery topic so we form a mesh
  // with browsers and relay their announcements.
  (helia.libp2p.services as any).pubsub
    .subscribe(DISCOVERY_TOPIC);

  log("started, peer ID:", helia.libp2p.peerId);

  const addrs = helia.libp2p.getMultiaddrs();
  for (const ma of addrs) {
    log("  listening:", ma.toString());
  }

  // Compute well-known CIDs for each app ID
  const cids = await Promise.all(
    config.appIds.map(appIdToCID),
  );

  async function provideAll() {
    for (let i = 0; i < cids.length; i++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(
          () => ctrl.abort(),
          30_000,
        );
        await helia.routing.provide(cids[i], {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        log(
          `provide OK for ${config.appIds[i]}`,
        );
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.includes("abort")) {
          log(
            `provide FAIL for`,
            `${config.appIds[i]}: ${msg}`,
          );
        }
      }
    }
  }

  // Initial provide (in background)
  provideAll();

  // Periodic re-provide
  const provideInterval = setInterval(
    provideAll,
    PROVIDE_INTERVAL_MS,
  );

  // Periodic status logging
  const logInterval = setInterval(() => {
    const peers = helia.libp2p.getPeers();
    const ma = helia.libp2p.getMultiaddrs();
    log(
      `${peers.length} peers,`,
      `${ma.length} addrs`,
    );
  }, LOG_INTERVAL_MS);

  return {
    async stop() {
      clearInterval(provideInterval);
      clearInterval(logInterval);
      await helia.stop();
      log("stopped");
    },

    multiaddrs() {
      return helia.libp2p
        .getMultiaddrs()
        .map((ma) => ma.toString());
    },

    peerId() {
      return helia.libp2p.peerId.toString();
    },
  };
}
