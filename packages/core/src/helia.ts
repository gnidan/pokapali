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
   *  blockstore-idb. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockstore?: any;
}

type HeliaWithPubsub = Helia<
  Libp2p<{
    pubsub: PubSub;
  }>
>;

// Discriminated union lifecycle state machine (#186).
// Replaces 5 ad-hoc module-level variables with one
// state variable that makes impossible states
// structurally impossible.
type HeliaState =
  | { phase: "idle" }
  | {
      phase: "bootstrapping";
      promise: Promise<HeliaWithPubsub>;
      deferredDestroy: boolean;
    }
  | {
      phase: "ready";
      instance: HeliaWithPubsub;
      refCount: number;
    }
  | {
      phase: "destroying";
      promise: Promise<void>;
    };

let state: HeliaState = { phase: "idle" };

// Re-read state after an await boundary. TypeScript
// narrows `state` within an if-block but doesn't
// account for mutations during await. This helper
// forces a fresh read.
function currentState(): HeliaState {
  return state;
}

export async function acquireHelia(
  _options?: HeliaOptions,
): Promise<HeliaWithPubsub> {
  if (state.phase === "ready") {
    state.refCount++;
    return state.instance;
  }

  // Another caller is already creating Helia — piggy-
  // back on that promise (#106).
  if (state.phase === "bootstrapping") {
    const helia = await state.promise;
    // Re-read: state may have changed during await
    // (deferred destroy, error, etc.)
    const s = currentState();
    if (s.phase !== "ready") {
      throw new Error(
        "Helia creation aborted: the Helia instance" +
          " was released while still bootstrapping" +
          " (all Docs were destroyed before" +
          " initialization finished)",
      );
    }
    s.refCount++;
    return helia;
  }

  // Wait for destroy to complete before creating new
  // instance (prevents race #186).
  if (state.phase === "destroying") {
    await state.promise;
  }

  const promise = createHeliaInstance(_options);
  state = {
    phase: "bootstrapping",
    promise,
    deferredDestroy: false,
  };
  try {
    const helia = await promise;
    return helia;
  } catch (err) {
    // On failure, reset to idle so next acquire can
    // retry.
    if (state.phase === "bootstrapping") {
      state = { phase: "idle" };
    }
    throw err;
  }
}

async function createHeliaInstance(
  _options?: HeliaOptions,
): Promise<HeliaWithPubsub> {
  // State is already set to "bootstrapping" by
  // acquireHelia() before calling this function.

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

  const helia = (await Promise.race([
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

  // releaseHelia() was called while we were creating
  // the instance (#107). Tear down immediately.
  if (state.phase === "bootstrapping" && state.deferredDestroy) {
    state = { phase: "idle" };
    await helia.stop();
    throw new Error(
      "Helia creation aborted: the Helia instance" +
        " was released while still bootstrapping" +
        " (all Docs were destroyed before" +
        " initialization finished)",
    );
  }

  state = { phase: "ready", instance: helia, refCount: 1 };
  return helia;
}

export async function releaseHelia(): Promise<void> {
  // Released during bootstrap (#107) — defer
  // destruction until createHeliaInstance() finishes.
  if (state.phase === "bootstrapping") {
    state.deferredDestroy = true;
    return;
  }

  if (state.phase !== "ready") {
    return;
  }

  state.refCount--;
  if (state.refCount === 0) {
    const h = state.instance;
    const promise = h.stop();
    state = { phase: "destroying", promise };
    await promise;
    // Only reset to idle if we're still in destroying
    // (acquireHelia may have already transitioned us).
    if (state.phase === "destroying") {
      state = { phase: "idle" };
    }
  }
}

export function getHeliaPubsub(): PubSub {
  if (state.phase !== "ready") {
    throw new Error(
      "No Helia instance exists — ensure a Doc has" +
        " been created or opened before accessing" +
        " the P2P network layer",
    );
  }
  return state.instance.libp2p.services.pubsub;
}

export function getHelia(): Helia {
  if (state.phase !== "ready") {
    throw new Error(
      "No Helia instance exists — ensure a Doc has" +
        " been created or opened before accessing" +
        " the P2P network layer",
    );
  }
  return state.instance;
}

/**
 * True when a shared Helia instance already exists.
 * Callers should skip creating a new blockstore when
 * this returns true — acquireHelia will ignore the
 * blockstore option and just increment the ref count.
 */
export function isHeliaLive(): boolean {
  return state.phase === "ready";
}

/**
 * Reset internal state. For testing only.
 */
export function _resetHeliaState(): void {
  state = { phase: "idle" };
}
