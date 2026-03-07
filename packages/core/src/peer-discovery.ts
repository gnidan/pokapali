import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 30_000;

/**
 * Derive a CID from a GossipSub topic name. Peers
 * `provide` this CID on the DHT to announce presence,
 * and `findProviders` to discover other peers in the
 * same room.
 */
async function topicToCID(topic: string): Promise<CID> {
  const bytes = new TextEncoder().encode(topic);
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

export interface RoomDiscovery {
  stop(): void;
}

/**
 * Start DHT-based peer discovery for a set of room
 * topics. Provides our presence and periodically
 * searches for + dials other peers on the same topics.
 */
export function startRoomDiscovery(
  helia: Helia,
  roomTopics: string[],
): RoomDiscovery {
  let stopped = false;
  const controller = new AbortController();

  async function provideAndDiscover() {
    for (const topic of roomTopics) {
      if (stopped) return;
      try {
        const cid = await topicToCID(topic);
        await helia.routing.provide(cid, {
          signal: controller.signal,
        });
      } catch {
        // DHT provide can fail if no peers — ignore
      }
    }

    for (const topic of roomTopics) {
      if (stopped) return;
      try {
        const cid = await topicToCID(topic);
        for await (const provider of
          helia.routing.findProviders(cid, {
            signal: controller.signal,
          })
        ) {
          if (stopped) return;
          try {
            await helia.libp2p.dial(
              provider.id,
              { signal: controller.signal },
            );
          } catch {
            // peer unreachable — normal
          }
        }
      } catch {
        // findProviders can fail — ignore
      }
    }
  }

  // Initial discovery
  provideAndDiscover();

  // Periodic re-discovery
  const interval = setInterval(() => {
    if (!stopped) {
      provideAndDiscover();
    }
  }, DISCOVERY_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      controller.abort();
      clearInterval(interval);
    },
  };
}
