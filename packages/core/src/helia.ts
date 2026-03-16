import { createHelia, libp2pDefaults } from "helia";
import { bootstrap } from "@libp2p/bootstrap";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import type { Helia } from "helia";
import type { Libp2p, PubSub } from "@libp2p/interface";
import { TimeoutError } from "./errors.js";

const DISCOVERY_TOPIC = "pokapali._peer-discovery._p2p._pubsub";

export interface HeliaOptions {
  bootstrapPeers?: string[];
  /** Optional blockstore (e.g. IDBBlockstore for
   *  browser persistence). Defaults to in-memory.
   *  Typed loosely to avoid interface-blockstore
   *  version conflicts between helia and
   *  blockstore-idb.
   *  TODO(#20): revisit when helia and blockstore-idb
   *  align on interface-blockstore version */
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

// Guards concurrent acquireHelia() calls (#106).
// While createHelia() is in-flight, subsequent callers
// await the same promise instead of spawning a second
// instance.
let pendingCreate: Promise<HeliaWithPubsub> | null = null;

// True while createHelia() is running (#107). If
// releaseHelia() is called during bootstrap it sets
// deferredDestroy so the instance is torn down once
// creation completes.
let bootstrapping = false;
let deferredDestroy = false;

export async function acquireHelia(
  _options?: HeliaOptions,
): Promise<HeliaWithPubsub> {
  if (sharedHelia) {
    refCount++;
    return sharedHelia;
  }

  // Another caller is already creating Helia — piggy-
  // back on that promise (#106).
  if (pendingCreate) {
    const helia = await pendingCreate;
    refCount++;
    return helia;
  }

  pendingCreate = createHeliaInstance(_options);
  try {
    const helia = await pendingCreate;
    return helia;
  } finally {
    pendingCreate = null;
  }
}

async function createHeliaInstance(
  _options?: HeliaOptions,
): Promise<HeliaWithPubsub> {
  bootstrapping = true;
  deferredDestroy = false;

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
      ...(_options?.bootstrapPeers?.length
        ? [bootstrap({ list: _options.bootstrapPeers })]
        : []),
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

  let helia: HeliaWithPubsub;
  try {
    helia = (await Promise.race([
      createHelia(heliaOpts),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new TimeoutError(
                "Helia bootstrap timed out after " +
                  `${BOOTSTRAP_TIMEOUT_MS / 1000}s` +
                  " — check network connectivity" +
                  " and ensure relay addresses" +
                  " are reachable",
              ),
            ),
          BOOTSTRAP_TIMEOUT_MS,
        ),
      ),
    ])) as unknown as HeliaWithPubsub;
  } catch (err) {
    bootstrapping = false;
    deferredDestroy = false;
    throw err;
  }

  bootstrapping = false;

  // releaseHelia() was called while we were creating
  // the instance (#107). Tear down immediately.
  if (deferredDestroy) {
    deferredDestroy = false;
    await helia.stop();
    throw new Error(
      "Helia creation aborted: the Helia instance" +
        " was released while still bootstrapping" +
        " (all Docs were destroyed before" +
        " initialization finished)",
    );
  }

  sharedHelia = helia;
  refCount = 1;
  return helia;
}

export async function releaseHelia(): Promise<void> {
  // Released during bootstrap (#107) — defer
  // destruction until createHeliaInstance() finishes.
  if (bootstrapping) {
    deferredDestroy = true;
    return;
  }

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
    throw new Error(
      "No Helia instance exists — ensure a Doc has" +
        " been created or opened before accessing" +
        " the P2P network layer",
    );
  }
  return sharedHelia.libp2p.services.pubsub;
}

export function getHelia(): Helia {
  if (!sharedHelia) {
    throw new Error(
      "No Helia instance exists — ensure a Doc has" +
        " been created or opened before accessing" +
        " the P2P network layer",
    );
  }
  return sharedHelia;
}

/**
 * True when a shared Helia instance already exists.
 * Callers should skip creating a new blockstore when
 * this returns true — acquireHelia will ignore the
 * blockstore option and just increment the ref count.
 */
export function isHeliaLive(): boolean {
  return sharedHelia !== null;
}

/**
 * Reset internal state. For testing only.
 */
export function _resetHeliaState(): void {
  sharedHelia = null;
  refCount = 0;
  pendingCreate = null;
  bootstrapping = false;
  deferredDestroy = false;
}
