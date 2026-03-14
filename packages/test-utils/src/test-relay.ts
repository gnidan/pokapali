/**
 * Minimal libp2p relay for Playwright E2E tests.
 *
 * Provides WebSocket transport + GossipSub mesh +
 * circuit-relay-v2 server. No DHT, TLS, blockstore,
 * or external network deps. Starts in <2s.
 */

import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";

export interface TestRelay {
  /** ws://127.0.0.1:<port>/ws/p2p/<peerId> */
  multiaddr: string;
  peerId: string;
  stop(): Promise<void>;
}

export interface TestRelayOptions {
  /** Port to listen on. Default: 0 (random). */
  port?: number;
}

export async function createTestRelay(
  options?: TestRelayOptions,
): Promise<TestRelay> {
  const port = options?.port ?? 0;

  const node = await createLibp2p({
    addresses: {
      listen: [`/ip4/127.0.0.1/tcp/${port}/ws`],
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        D: 3,
        Dlo: 3,
        Dhi: 8,
        Dout: 1,
        Dscore: 1,
        scoreParams: {
          IPColocationFactorWeight: 0,
        },
      }),
      relay: circuitRelayServer(),
    },
  });

  const pid = node.peerId.toString();
  const wsAddr = node
    .getMultiaddrs()
    .find((ma) => ma.toString().includes("/ws"));

  if (!wsAddr) {
    await node.stop();
    throw new Error("Relay failed to bind WebSocket");
  }

  const addr = wsAddr.toString();
  let stopped = false;

  return {
    multiaddr: addr,
    peerId: pid,
    async stop() {
      if (stopped) return;
      stopped = true;
      await node.stop();
    },
  };
}
