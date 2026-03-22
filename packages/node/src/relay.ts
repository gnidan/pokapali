import { join } from "node:path";
import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { autoTLS } from "@ipshipyard/libp2p-auto-tls";
import { kadDHT } from "@libp2p/kad-dht";
import { ipnsValidator } from "ipns/validator";
import { ipnsSelector } from "ipns/selector";
import { LevelDatastore } from "datastore-level";
import type { Helia } from "helia";
import type { PubSub } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { createDelegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { delegatedHTTPRoutingDefaults } from "@helia/routers";
import { createLogger } from "@pokapali/log";

import {
  MAX_CONNECTIONS,
  DISCOVERY_TOPIC,
  SIGNALING_TOPIC,
  PROVIDE_INTERVAL_MS,
  CAPS_INTERVAL_MS,
  DEFAULT_WS_PORT,
  BOOTSTRAP_ADDRS,
  loadOrCreateKey,
  openBlockstore,
  networkCID,
} from "./relay-utils.js";
import {
  NODE_CAPS_TOPIC,
  setupCapsListener,
  setupDynamicSubscription,
  publishCaps,
} from "./relay-caps.js";
import { provideAll, scheduleHealthCheck } from "./relay-discovery.js";
import { startStatusLogging } from "./relay-logging.js";

// Re-export public API so consumers don't need to
// change import paths.
export type { NodeCapabilities, NodeNeighbor } from "./relay-caps.js";
export {
  NODE_CAPS_TOPIC,
  encodeNodeCaps,
  decodeNodeCaps,
} from "./relay-caps.js";
export {
  appIdToCID,
  deriveHttpUrl,
  deriveHttpUrlFromCert,
} from "./relay-utils.js";

const log = createLogger("relay");

export interface RelayConfig {
  storagePath: string;
  wsPort?: number;
  tcpPort?: number;
  // Public multiaddrs to announce (e.g. for autoTLS).
  announceAddrs?: string[];
  // Node roles to advertise (e.g. ["relay"],
  // ["relay", "pinner"]). Defaults to ["relay"].
  roles?: string[];
  // Custom delegated routing endpoint URL.
  delegatedRoutingUrl?: string;
  // Skip autoTLS cert provisioning.
  noTls?: boolean;
}

export interface Relay {
  stop(): Promise<void>;
  multiaddrs(): string[];
  peerId(): string;
  helia: Helia;
  /** Set by bin/node.ts once the HTTPS block server
   *  is listening. Included in caps advertisements. */
  httpUrl: string | undefined;
}

export async function startRelay(config: RelayConfig): Promise<Relay> {
  const wsPort = config.wsPort ?? DEFAULT_WS_PORT;
  const tcpPort = config.tcpPort ?? 4001;
  const privateKey = await loadOrCreateKey(config.storagePath);
  const datastore = new LevelDatastore(join(config.storagePath, "datastore"));
  await datastore.open();

  const { blockstore } = await openBlockstore(config.storagePath);

  const { multiaddr } = await import("@multiformats/multiaddr");

  const listen = [
    `/ip4/0.0.0.0/tcp/${tcpPort}`,
    `/ip6/::/tcp/${tcpPort}`,
    `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
    `/ip6/::/tcp/${wsPort}/ws`,
    "/p2p-circuit",
  ];

  // Relay peer IDs discovered via DHT. Created before
  // Helia so the appSpecificScore callback can
  // reference it.
  const knownRelayPeerIds = new Set<string>();

  const defaults = libp2pDefaults();

  // Build services, omitting the default relay service
  // and optionally adding delegated routing.
  const { relay: _relay, ...baseServices } = {
    ...defaults.services,
    dht: kadDHT({
      clientMode: true,
      validators: { ipns: ipnsValidator },
      selectors: { ipns: ipnsSelector },
    }),
    pubsub: gossipsub({
      floodPublish: false,
      allowPublishToZeroTopicPeers: true,
      D: 3,
      Dlo: 3,
      Dhi: 8,
      Dout: 1,
      Dscore: 1,
      maxOutboundBufferSize: 10 * 1024 * 1024,
      scoreParams: {
        IPColocationFactorWeight: 0,
        appSpecificScore: (peerId: string) =>
          knownRelayPeerIds.has(peerId) ? 100 : 0,
        appSpecificWeight: 1,
      },
    }),
    ...(config.noTls
      ? {}
      : {
          autoTLS: autoTLS({
            autoConfirmAddress: true,
          }),
        }),
  };
  void _relay;

  const services = config.delegatedRoutingUrl
    ? {
        ...baseServices,
        delegatedRouting: () =>
          createDelegatedRoutingV1HttpApiClient(
            config.delegatedRoutingUrl!,
            delegatedHTTPRoutingDefaults(),
          ),
      }
    : baseServices;

  if (config.delegatedRoutingUrl) {
    log.info("delegated routing:", config.delegatedRoutingUrl);
  }

  // blockstore-fs@3 and datastore-level have
  // compatible runtime interfaces but divergent
  // type declarations. Cast at the Helia boundary.
  const helia = (await createHelia({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blockstore: blockstore as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    datastore: datastore as any,
    libp2p: {
      ...defaults,
      privateKey,
      addresses: {
        ...defaults.addresses,
        listen,
        appendAnnounce: config.announceAddrs,
      },
      peerDiscovery: [],
      connectionManager: {
        ...defaults.connectionManager,
        maxConnections: MAX_CONNECTIONS,
        maxIncomingPendingConnections: 10,
      },
      services,
    },
  })) as Helia;

  log.info("started, peer ID:", helia.libp2p.peerId);
  for (const ma of helia.libp2p.getMultiaddrs()) {
    log.info("  listening:", ma.toString());
  }

  // --- Bootstrap + cert wait ---

  await dialBootstrap(helia, multiaddr);

  if (!config.noTls) {
    await waitForCert(helia);
  } else {
    log.info("TLS disabled, skipping cert wait");
  }

  log.info("re-dialing bootstrap peers...");
  for (const addr of BOOTSTRAP_ADDRS) {
    try {
      await helia.libp2p.dial(multiaddr(addr));
      log.info("  dialed", addr.split("/p2p/")[1]?.slice(0, 12));
    } catch {
      log.warn("  failed to dial", addr.split("/p2p/")[1]?.slice(0, 12));
    }
  }

  // --- PubSub subscriptions ---

  // Services type doesn't include pubsub since we
  // configure it dynamically. Access via known key.
  const pubsub = (helia.libp2p.services as Record<string, unknown>)
    .pubsub as PubSub;
  pubsub.subscribe(DISCOVERY_TOPIC);
  pubsub.subscribe(SIGNALING_TOPIC);
  log.info("subscribed to", DISCOVERY_TOPIC);
  log.info("subscribed to", SIGNALING_TOPIC);

  // --- Capabilities + dynamic subscription ---

  pubsub.subscribe(NODE_CAPS_TOPIC);
  const roles = config.roles ?? ["relay"];
  const selfPeerId = helia.libp2p.peerId.toString();
  const knownPeerRoles = new Map<string, string[]>();

  const removeCapsListener = setupCapsListener(
    pubsub,
    selfPeerId,
    knownPeerRoles,
  );

  const { autoSubOriginators, remove: removeDynSub } = setupDynamicSubscription(
    pubsub,
    knownPeerRoles,
  );

  let httpUrl: string | undefined;
  const doCaps = () =>
    publishCaps(
      helia,
      pubsub,
      selfPeerId,
      roles,
      knownPeerRoles,
      autoSubOriginators,
      httpUrl,
    );
  doCaps();
  const capsInterval = setInterval(doCaps, CAPS_INTERVAL_MS);
  log.info("advertising capabilities:", roles.join(", "));

  // --- DHT discovery + health ---

  const netCID = await networkCID();

  const doProvide = () => provideAll(helia, netCID, knownRelayPeerIds);

  const initialProvideTimer = setTimeout(() => {
    log.debug("initial provide starting...");
    doProvide();
  }, 45_000);

  let certRedialTimer: ReturnType<typeof setTimeout> | undefined;
  const onCertProvision = () => {
    log.info("certificate obtained, re-providing");
    certRedialTimer = setTimeout(() => doProvide(), 15_000);
  };
  helia.libp2p.addEventListener("certificate:provision", onCertProvision);

  const provideInterval = setInterval(doProvide, PROVIDE_INTERVAL_MS);

  const healthCheck = scheduleHealthCheck(helia, netCID, knownRelayPeerIds);

  // --- Status logging ---

  const logInterval = startStatusLogging(helia, pubsub);

  // --- Return relay handle ---

  return {
    helia,

    get httpUrl() {
      return httpUrl;
    },
    set httpUrl(url: string | undefined) {
      httpUrl = url;
    },

    async stop() {
      clearTimeout(initialProvideTimer);
      if (certRedialTimer) clearTimeout(certRedialTimer);
      healthCheck.clear();
      clearInterval(provideInterval);
      clearInterval(logInterval);
      clearInterval(capsInterval);
      removeCapsListener();
      removeDynSub();
      helia.libp2p.removeEventListener(
        "certificate:provision",
        onCertProvision,
      );
      await helia.stop();
      log.info("stopped");
    },

    multiaddrs() {
      return helia.libp2p.getMultiaddrs().map((ma) => ma.toString());
    },

    peerId() {
      return helia.libp2p.peerId.toString();
    },
  };
}

/**
 * Dial ONE bootstrap peer to trigger
 * self:peer:update (needed for autoTLS).
 */
async function dialBootstrap(
  helia: Helia,
  multiaddrFn: (addr: string) => Multiaddr,
): Promise<void> {
  log.info("dialing bootstrap peer...");
  for (const addr of BOOTSTRAP_ADDRS) {
    try {
      await helia.libp2p.dial(multiaddrFn(addr));
      log.info("  dialed", addr.split("/p2p/")[1]?.slice(0, 12));
      break;
    } catch {
      log.warn("  failed to dial", addr.split("/p2p/")[1]?.slice(0, 12));
    }
  }
}

/**
 * Wait for autoTLS cert with grace period.
 */
async function waitForCert(helia: Helia): Promise<void> {
  const CERT_WAIT_MS = 120_000;
  const CERT_GRACE_MS = 10_000;
  let certResolved = false;
  let closeTimer: ReturnType<typeof setInterval> | null = null;

  const certObtained = await new Promise<boolean>((resolve) => {
    const done = (v: boolean) => {
      certResolved = true;
      resolve(v);
    };
    const timer = setTimeout(() => {
      log.warn("autoTLS timeout, proceeding without WSS");
      done(false);
    }, CERT_WAIT_MS);

    helia.libp2p.addEventListener(
      "certificate:provision",
      () => {
        clearTimeout(timer);
        log.info("certificate obtained!");
        done(true);
      },
      { once: true },
    );

    const graceTimer = setTimeout(() => {
      if (certResolved) return;
      const closeAll = async () => {
        const conns = helia.libp2p.getConnections();
        log.debug(`closing ${conns.length}`, `connections for cert`);
        await Promise.allSettled(conns.map((c) => c.close()));
      };
      log.debug("cert not yet obtained, closing conns");
      closeAll();
      closeTimer = setInterval(closeAll, 3_000);
    }, CERT_GRACE_MS);

    helia.libp2p.addEventListener(
      "certificate:provision",
      () => clearTimeout(graceTimer),
      { once: true },
    );
  });

  if (closeTimer) clearInterval(closeTimer);

  if (certObtained) {
    const wssAddrs = helia.libp2p
      .getMultiaddrs()
      .filter((ma) => ma.toString().includes("/tls/"));
    for (const a of wssAddrs) {
      log.info("  WSS:", a.toString());
    }
  }
}
