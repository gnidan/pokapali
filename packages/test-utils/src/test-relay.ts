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
import {
  SIGNALING_PROTOCOL,
  createRoomRegistry,
  handleSignalingStream,
  createRelayForwarder,
} from "@pokapali/node";
import type { RelaySignalingStream } from "@pokapali/node";

export interface TestRelay {
  /** ws://127.0.0.1:<port>/ws/p2p/<peerId> */
  multiaddr: string;
  peerId: string;
  stop(): Promise<void>;
}

export interface TestRelayOptions {
  /** Port to listen on. Default: 0 (random). */
  port?: number;
  /** If provided, the relay publishes a v2 node-caps
   *  GossipSub message advertising this HTTP URL.
   *  Browsers that discover the relay will treat it
   *  as a pinner with an HTTP history endpoint. */
  httpUrl?: string;
}

const NODE_CAPS_TOPIC = "pokapali._node-caps._p2p._pubsub";

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

  // Register signaling protocol handler so browsers
  // can use the dedicated stream for WebRTC peer
  // discovery instead of GossipSub.
  const signalingRegistry = createRoomRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pubsubSvc = node.services.pubsub as any;
  const signalingForwarder = createRelayForwarder(
    pubsubSvc,
    pid,
    signalingRegistry,
  );
  await node.handle(SIGNALING_PROTOCOL, ({ stream, connection }) => {
    handleSignalingStream(
      connection.remotePeer.toString(),
      stream as unknown as RelaySignalingStream,
      {
        registry: signalingRegistry,
        forwarder: signalingForwarder,
      },
    );
  });
  const wsAddr = node
    .getMultiaddrs()
    .find((ma) => ma.toString().includes("/ws"));

  if (!wsAddr) {
    await node.stop();
    throw new Error("Relay failed to bind WebSocket");
  }

  const addr = wsAddr.toString();
  let stopped = false;
  let capsInterval: ReturnType<typeof setInterval> | undefined;

  // If httpUrl is provided, publish v2 node-caps so
  // browsers discover the relay as a pinner with an
  // HTTP history endpoint.
  if (options?.httpUrl) {
    const pubsub = node.services.pubsub;
    pubsub.subscribe(NODE_CAPS_TOPIC);

    const capsMsg = new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        peerId: pid,
        roles: ["relay"],
        httpUrl: options.httpUrl,
      }),
    );

    const publishCaps = () => {
      pubsub.publish(NODE_CAPS_TOPIC, capsMsg).catch(() => {});
    };

    // Publish immediately then every 10s so late
    // joiners discover the httpUrl.
    publishCaps();
    capsInterval = setInterval(publishCaps, 10_000);
  }

  return {
    multiaddr: addr,
    peerId: pid,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (capsInterval) clearInterval(capsInterval);
      signalingForwarder.stop();
      await node.unhandle(SIGNALING_PROTOCOL);
      await node.stop();
    },
  };
}
