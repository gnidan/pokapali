/**
 * Node.js Helia setup for load testing.
 *
 * Based on relay.ts pattern — TCP/WS transports,
 * GossipSub with floodPublish, no autoTLS, no
 * persistent key. Ephemeral identity per run.
 */

import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { kadDHT } from "@libp2p/kad-dht";
import { ipnsValidator } from "ipns/validator";
import { ipnsSelector } from "ipns/selector";
import type { Helia } from "helia";
import type { Libp2p, PubSub } from "@libp2p/interface";
import { createLogger } from "@pokapali/log";

const log = createLogger("load-test:helia");

export interface HeliaNodeOptions {
  /** Relay multiaddrs to dial on startup. */
  bootstrapPeers?: string[];
  /** TCP listen port. 0 = random. */
  tcpPort?: number;
  /** WS listen port. 0 = random. */
  wsPort?: number;
}

export type HeliaNode = Helia<Libp2p<{
  pubsub: PubSub;
}>>;

export async function createHeliaNode(
  options?: HeliaNodeOptions,
): Promise<HeliaNode> {
  const tcpPort = options?.tcpPort ?? 0;
  const wsPort = options?.wsPort ?? 0;

  const listen = [
    `/ip4/0.0.0.0/tcp/${tcpPort}`,
    `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
  ];

  const defaults = libp2pDefaults();
  const helia = await createHelia({
    libp2p: {
      ...defaults,
      addresses: {
        ...defaults.addresses,
        listen,
      },
      peerDiscovery: [],
      connectionManager: {
        ...defaults.connectionManager,
        maxConnections: 100,
      },
      services: (() => {
        const svc = {
          ...defaults.services,
          dht: kadDHT({
            clientMode: true,
            validators: { ipns: ipnsValidator },
            selectors: { ipns: ipnsSelector },
          }),
          pubsub: gossipsub({
            floodPublish: true,
            allowPublishToZeroTopicPeers: true,
            D: 3,
            Dlo: 2,
            Dhi: 6,
            Dout: 1,
            Dscore: 1,
            scoreParams: {
              IPColocationFactorWeight: 0,
            },
          }),
        };
        // Remove browser-only services
        delete (svc as any).relay;
        return svc;
      })(),
    },
  }) as unknown as HeliaNode;

  log.info(
    "started, peer ID:",
    helia.libp2p.peerId.toString(),
  );

  // Dial bootstrap/relay peers
  if (options?.bootstrapPeers?.length) {
    const { multiaddr } = await import(
      "@multiformats/multiaddr"
    );
    for (const addr of options.bootstrapPeers) {
      try {
        await helia.libp2p.dial(multiaddr(addr));
        log.info("dialed", addr.slice(-30));
      } catch (err) {
        log.warn(
          "failed to dial",
          addr.slice(-30),
          (err as Error).message,
        );
      }
    }
  }

  return helia;
}
