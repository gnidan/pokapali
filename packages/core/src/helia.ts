import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import {
  pubsubPeerDiscovery,
} from "@libp2p/pubsub-peer-discovery";
import type { Helia } from "helia";
import type { Libp2p, PubSub } from "@libp2p/interface";

const DISCOVERY_TOPIC =
  "pokapali._peer-discovery._p2p._pubsub";

export interface HeliaOptions {
  bootstrapPeers?: string[];
}

interface HeliaWithPubsub extends Helia<Libp2p<{
  pubsub: PubSub;
}>> {}

let sharedHelia: HeliaWithPubsub | null = null;
let refCount = 0;

export async function acquireHelia(
  options?: HeliaOptions
): Promise<HeliaWithPubsub> {
  if (sharedHelia) {
    refCount++;
    return sharedHelia;
  }

  const defaults = libp2pDefaults();
  const libp2pOptions = {
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
  };

  const helia = await createHelia({
    libp2p: libp2pOptions,
  }) as unknown as HeliaWithPubsub;

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
