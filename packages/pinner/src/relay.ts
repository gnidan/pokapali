import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { autoTLS } from "@ipshipyard/libp2p-auto-tls";
import { LevelDatastore } from "datastore-level";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import type { Helia } from "helia";
import type { PrivateKey } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// Max peers for the relay. Keep low so the event loop
// stays responsive for autoTLS cert provisioning.
const MAX_CONNECTIONS = 50;
const MIN_CONNECTIONS = 5;

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
  // Public multiaddrs to announce (e.g. for autoTLS).
  // Needed so autoTLS knows our public IP before any
  // peers connect and report observed addresses.
  announceAddrs?: string[];
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
  // Phase 1: Start on random ports with no peer
  // discovery. The known ports (4001, 4003) attract
  // inbound DHT connections from previous announces,
  // which saturate the CPU and block autoTLS cert
  // provisioning. We start on ephemeral ports, get
  // the cert, then stop and restart on real ports.
  const datastore = new LevelDatastore(
    join(config.storagePath, "datastore"),
  );
  await datastore.open();

  // Cert-provisioning node: ephemeral ports, no
  // discovery, minimal connections.
  const certDefaults = libp2pDefaults();
  const certNode = await createHelia({
    datastore,
    libp2p: {
      ...certDefaults,
      privateKey,
      addresses: {
        ...certDefaults.addresses,
        listen: [
          "/ip4/0.0.0.0/tcp/0",
          "/ip6/::/tcp/0",
        ],
        announce: config.announceAddrs,
      },
      peerDiscovery: [],
      connectionManager: {
        ...certDefaults.connectionManager,
        maxConnections: 5,
        minConnections: 0,
        maxIncomingPendingConnections: 2,
      },
      services: {
        ...certDefaults.services,
        pubsub: gossipsub(),
        autoTLS: autoTLS({
          autoConfirmAddress: true,
        }),
      },
    },
  }) as Helia;

  log("cert node started, peer ID:", certNode.libp2p.peerId);

  // Dial one bootstrap peer to trigger address
  // observation → self:peer:update → autoTLS.
  const { multiaddr } = await import(
    "@multiformats/multiaddr"
  );
  const bootstrapAddrs = [
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
  ];
  log("dialing bootstrap peer for address observation...");
  for (const addr of bootstrapAddrs) {
    try {
      await certNode.libp2p.dial(multiaddr(addr));
      log(
        "  dialed",
        addr.split("/p2p/")[1]?.slice(0, 12),
      );
      break;
    } catch {
      log(
        "  failed to dial",
        addr.split("/p2p/")[1]?.slice(0, 12),
      );
    }
  }

  // Wait for autoTLS cert (or timeout). The ephemeral
  // ports prevent the inbound DHT flood, keeping the
  // event loop free for ACME HTTP requests.
  const CERT_WAIT_MS = 120_000;
  const certObtained = await new Promise<boolean>(
    (resolve) => {
      const timer = setTimeout(() => {
        log("autoTLS timeout, proceeding without WSS");
        resolve(false);
      }, CERT_WAIT_MS);
      certNode.libp2p.addEventListener(
        "certificate:provision",
        () => {
          clearTimeout(timer);
          log("certificate obtained!");
          resolve(true);
        },
        { once: true },
      );
    },
  );

  if (certObtained) {
    const wssAddrs = certNode.libp2p
      .getMultiaddrs()
      .filter((ma) => ma.toString().includes("/tls/"));
    for (const a of wssAddrs) {
      log("  WSS:", a.toString());
    }
  }

  // Stop the cert node — it served its purpose.
  await certNode.stop();
  // Reopen the datastore (Helia may have closed it).
  await datastore.close();
  await datastore.open();
  log("cert node stopped, datastore reopened");

  // Phase 2: Start the real relay on the known ports
  // with full connection limits. The cert is persisted
  // in the datastore; autoTLS will load it on the
  // first self:peer:update.
  const listen = [
    "/ip4/0.0.0.0/tcp/4001",
    "/ip6/::/tcp/4001",
    `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
    `/ip6/::/tcp/${wsPort}/ws`,
    "/p2p-circuit",
  ];

  const relayDefaults = libp2pDefaults();
  const helia = await createHelia({
    datastore,
    libp2p: {
      ...relayDefaults,
      privateKey,
      addresses: {
        ...relayDefaults.addresses,
        listen,
        announce: config.announceAddrs,
      },
      peerDiscovery: [],
      connectionManager: {
        ...relayDefaults.connectionManager,
        maxConnections: MAX_CONNECTIONS,
        minConnections: MIN_CONNECTIONS,
        maxIncomingPendingConnections: 10,
      },
      services: {
        ...relayDefaults.services,
        pubsub: gossipsub(),
        autoTLS: autoTLS({
          autoConfirmAddress: true,
        }),
      },
    },
  }) as Helia;

  log("relay started, peer ID:", helia.libp2p.peerId);

  const addrs = helia.libp2p.getMultiaddrs();
  for (const ma of addrs) {
    log("  listening:", ma.toString());
  }

  // Connect to bootstrap peers for DHT/GossipSub.
  log("connecting to bootstrap peers...");
  for (const addr of bootstrapAddrs) {
    try {
      await helia.libp2p.dial(multiaddr(addr));
      log(
        "  dialed",
        addr.split("/p2p/")[1]?.slice(0, 12),
      );
    } catch {
      log(
        "  failed to dial",
        addr.split("/p2p/")[1]?.slice(0, 12),
      );
    }
  }

  // Subscribe to the discovery topic so this node
  // joins the GossipSub mesh and relays peer
  // announcements between browsers.
  const pubsub = (helia.libp2p.services as any).pubsub;
  pubsub.subscribe(DISCOVERY_TOPIC);
  pubsub.subscribe(SIGNALING_TOPIC);
  log("subscribed to", DISCOVERY_TOPIC);
  log("subscribed to", SIGNALING_TOPIC);

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

  // Re-provide after autoTLS certificate is obtained
  // so the DHT peer record includes WSS addresses.
  helia.libp2p.addEventListener(
    "certificate:provision",
    () => {
      log("certificate obtained, re-providing");
      provideAll();
    },
  );

  // Periodic re-provide
  const provideInterval = setInterval(
    provideAll,
    PROVIDE_INTERVAL_MS,
  );

  // Periodic status logging
  let lastAddrCount = 0;
  const logInterval = setInterval(() => {
    const conns = helia.libp2p.getConnections();
    const peers = helia.libp2p.getPeers();
    const ma = helia.libp2p.getMultiaddrs();
    log(
      `${conns.length} conns,`,
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
