import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import type { Helia } from "helia";
import type { Libp2p, PubSub } from "@libp2p/interface";

const DISCOVERY_TOPIC = "pokapali._peer-discovery._p2p._pubsub";

export interface HeliaOptions {
  bootstrapPeers?: string[];
  /** Optional blockstore (e.g. IDBBlockstore for
   *  browser persistence). Defaults to in-memory.
   *  Typed loosely to avoid interface-blockstore
   *  version conflicts between helia and
   *  blockstore-idb. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockstore?: any;
}

type HeliaWithPubsub = Helia<
  Libp2p<{
    pubsub: PubSub;
  }>
>;

let sharedHelia: HeliaWithPubsub | null = null;
let refCount = 0;

export async function acquireHelia(
  _options?: HeliaOptions,
): Promise<HeliaWithPubsub> {
  if (sharedHelia) {
    refCount++;
    return sharedHelia;
  }

  const isSecureContext =
    typeof globalThis.location !== "undefined" &&
    globalThis.location.protocol === "https:";

  const defaults = libp2pDefaults();
  const libp2pOptions = {
    ...defaults,
    connectionManager: {
      ...defaults.connectionManager,
      // Ensure the connection manager actively maintains
      // connections to relays, preventing all connections
      // from being pruned during idle periods.
      minConnections: 5,
      // Keep low to prevent accumulating DHT/bootstrap
      // peers that trigger pruning of relay connections.
      maxConnections: 25,
    },
    peerDiscovery: [
      ...(defaults.peerDiscovery ?? []),
      pubsubPeerDiscovery({
        interval: 10_000,
        topics: [DISCOVERY_TOPIC],
      }),
    ],
    services: {
      ...defaults.services,
      pubsub: gossipsub({
        // Mesh routing: let GossipSub forward via
        // mesh peers. floodPublish causes broadcast
        // storms at scale (1000+ docs).
        floodPublish: false,
        allowPublishToZeroTopicPeers: true,
        // Browsers connect to 2-4 relays, so keep
        // mesh params modest.
        D: 3,
        Dlo: 2,
        Dhi: 6,
        Dout: 1,
        Dscore: 1,
        // Disable IP colocation penalty. Browsers
        // connect via p2p-circuit, sharing the relay's
        // IP, triggering false positives.
        // Cap per-peer outbound buffer. Browsers have
        // limited upload bandwidth; 2MB prevents buffer
        // bloat from inline-block announcements.
        maxOutboundBufferSize: 2 * 1024 * 1024,
        scoreParams: {
          IPColocationFactorWeight: 0,
        },
      }),
    },
    // Block plain ws:// dials from HTTPS pages — browsers
    // reject mixed content and the failed attempts waste
    // connection slots and time.
    ...(isSecureContext
      ? {
          connectionGater: {
            ...defaults.connectionGater,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            denyDialMultiaddr: (ma: any) => {
              const s = ma.toString();
              if (s.includes("/ws/") || s.endsWith("/ws")) {
                return !s.includes("/tls/");
              }
              return false;
            },
          },
        }
      : {}),
  };

  const BOOTSTRAP_TIMEOUT_MS = 30_000;
  const heliaOpts: Parameters<typeof createHelia>[0] = {
    libp2p: libp2pOptions,
  };
  if (_options?.blockstore) {
    heliaOpts.blockstore = _options.blockstore;
  }
  const helia = (await Promise.race([
    createHelia(heliaOpts),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Helia bootstrap timed out")),
        BOOTSTRAP_TIMEOUT_MS,
      ),
    ),
  ])) as unknown as HeliaWithPubsub;

  sharedHelia = helia;
  refCount = 1;
  return helia;
}

export async function releaseHelia(): Promise<void> {
  if (!sharedHelia || refCount <= 0) {
    return;
  }
  refCount--;
  if (refCount === 0) {
    const h = sharedHelia;
    sharedHelia = null;
    await h.stop();
  }
}

export function getHeliaPubsub(): PubSub {
  if (!sharedHelia) {
    throw new Error("No Helia instance exists");
  }
  return sharedHelia.libp2p.services.pubsub;
}

export function getHelia(): Helia {
  if (!sharedHelia) {
    throw new Error("No Helia instance exists");
  }
  return sharedHelia;
}

/**
 * Reset internal state. For testing only.
 */
export function _resetHeliaState(): void {
  sharedHelia = null;
  refCount = 0;
}
