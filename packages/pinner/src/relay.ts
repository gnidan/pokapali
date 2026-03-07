import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import type { Helia } from "helia";
import type { PrivateKey } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DISCOVERY_TOPIC =
  "pokapali._peer-discovery._p2p._pubsub";
const SIGNALING_TOPIC = "/pokapali/signaling";
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

const DEFAULT_WS_PORT = 4003;
const KEY_FILENAME = "relay-key.bin";

async function loadOrCreateKey(
  storagePath: string,
): Promise<PrivateKey> {
  const keyPath = join(storagePath, KEY_FILENAME);
  try {
    const buf = await readFile(keyPath);
    const key = privateKeyFromProtobuf(buf);
    log("loaded existing key from", keyPath);
    return key;
  } catch {
    // Generate new key and persist it
    const key = await generateKeyPair("Ed25519");
    await mkdir(storagePath, { recursive: true });
    await writeFile(keyPath, privateKeyToProtobuf(key));
    log("generated new key, saved to", keyPath);
    return key;
  }
}

export interface RelayConfig {
  appIds: string[];
  storagePath: string;
  wsPort?: number;
}

export interface Relay {
  stop(): Promise<void>;
  multiaddrs(): string[];
  peerId(): string;
}

export async function startRelay(
  config: RelayConfig,
): Promise<Relay> {
  const wsPort = config.wsPort ?? DEFAULT_WS_PORT;
  const privateKey = await loadOrCreateKey(
    config.storagePath,
  );
  const defaults = libp2pDefaults();

  // Replace the random-port WS listeners with a
  // fixed port so browsers can connect directly.
  const addresses = {
    ...defaults.addresses,
    listen: [
      ...(defaults.addresses?.listen ?? []).filter(
        (a: string) => !a.includes("/ws"),
      ),
      `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
      `/ip6/::/tcp/${wsPort}/ws`,
    ],
  };

  const helia = await createHelia({
    libp2p: {
      ...defaults,
      privateKey,
      addresses,
      services: {
        ...defaults.services,
        pubsub: gossipsub(),
      },
    },
  }) as Helia;

  // Subscribe to the discovery topic so this node
  // joins the GossipSub mesh and relays peer
  // announcements between browsers.
  const pubsub = (helia.libp2p.services as any).pubsub;
  pubsub.subscribe(DISCOVERY_TOPIC);
  pubsub.subscribe(SIGNALING_TOPIC);

  log("started, peer ID:", helia.libp2p.peerId);
  log("subscribed to", DISCOVERY_TOPIC);
  log("subscribed to", SIGNALING_TOPIC);

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
  let lastAddrCount = 0;
  const logInterval = setInterval(() => {
    const peers = helia.libp2p.getPeers();
    const ma = helia.libp2p.getMultiaddrs();
    log(
      `${peers.length} peers,`,
      `${ma.length} addrs`,
    );
    if (ma.length !== lastAddrCount) {
      lastAddrCount = ma.length;
      for (const a of ma) {
        log("  addr:", a.toString());
      }
    }
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
