import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 30_000;

const log = (...args: unknown[]) =>
  console.log("[pokapali:discovery]", ...args);

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

  const shortTopic = (t: string) =>
    t.replace("/pokapali/signal/", "");

  async function provideAndDiscover() {
    log(
      "starting provide/discover cycle,",
      `${helia.libp2p.getPeers().length} peers connected`
    );

    // Provide phase
    for (const topic of roomTopics) {
      if (stopped) return;
      try {
        const cid = await topicToCID(topic);
        log(`provide ${shortTopic(topic)}`, cid.toString().slice(0, 16) + "...");
        await helia.routing.provide(cid, {
          signal: controller.signal,
        });
        log(`provide OK ${shortTopic(topic)}`);
      } catch (err) {
        log(
          `provide FAIL ${shortTopic(topic)}:`,
          (err as Error).message ?? err,
        );
      }
    }

    // Discover phase
    for (const topic of roomTopics) {
      if (stopped) return;
      try {
        const cid = await topicToCID(topic);
        log(`findProviders ${shortTopic(topic)}...`);
        let found = 0;
        for await (const provider of
          helia.routing.findProviders(cid, {
            signal: controller.signal,
          })
        ) {
          if (stopped) return;
          found++;
          const peerId = provider.id.toString();
          const short = peerId.slice(-8);
          const already = helia.libp2p.getPeers()
            .some(p => p.toString() === peerId);
          if (already) {
            log(
              `  found provider ...${short}`,
              "(already connected)",
            );
            continue;
          }
          log(`  found provider ...${short}, dialing...`);
          try {
            await helia.libp2p.dial(
              provider.id,
              { signal: controller.signal },
            );
            log(`  dialed ...${short} OK`);
          } catch (err) {
            log(
              `  dial ...${short} FAIL:`,
              (err as Error).message ?? err,
            );
          }
        }
        log(
          `findProviders ${shortTopic(topic)}:`,
          `${found} provider(s)`,
        );
      } catch (err) {
        log(
          `findProviders FAIL ${shortTopic(topic)}:`,
          (err as Error).message ?? err,
        );
      }
    }

    log(
      "cycle complete,",
      `${helia.libp2p.getPeers().length} peers now`,
    );
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
