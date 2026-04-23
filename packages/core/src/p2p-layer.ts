/**
 * p2p-layer.ts — Helia bootstrap and relay wiring.
 *
 * Extracted from index.ts. Handles blockstore setup,
 * Helia acquisition, node-registry, relay discovery,
 * multi-relay awareness room, and signaling.
 */

import type { Awareness } from "y-protocols/awareness";
import {
  setupNamespaceRooms,
  setupSignaledAwarenessRoom,
  createSignalingClient,
  createMultiRelayRoom,
  SIGNALING_PROTOCOL,
} from "@pokapali/sync";
import type {
  SyncOptions,
  PubSubLike,
  SignalingStream,
  AwarenessRoom,
  MultiRelayRoom,
  SyncManager,
} from "@pokapali/sync";
import {
  acquireHelia,
  releaseHelia,
  getHeliaPubsub,
  getHelia,
  isHeliaLive,
} from "./helia.js";
import { acquireNodeRegistry } from "./node-registry.js";
import { startRoomDiscovery } from "./peer-discovery.js";
import type { RoomDiscovery } from "./peer-discovery.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("core");

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface P2PLayerResult {
  pubsub: PubSubLike;
  syncManager: SyncManager;
  awarenessRoom: MultiRelayRoom;
  roomDiscovery: RoomDiscovery;
  requestReconnect(): void;
  closeBlockstore?: () => Promise<void>;
}

export interface P2PLayerOptions {
  appId: string;
  networkId: string;
  ipnsName: string;
  channelKeys: Record<string, Uint8Array>;
  signalingUrls: string[];
  awareness: Awareness;
  bootstrapPeers?: string[];
  rtcIceServers?: RTCIceServer[];
  /** Pre-created multi-relay room. When provided,
   *  setupP2PLayer uses it instead of creating one.
   *  This lets callers register onPeerCreated
   *  before any relay connects — avoiding the race
   *  where peers join during trySignaling before
   *  the consumer callback is registered. */
  multiRoom?: MultiRelayRoom;
}

const RELAY_WAIT_MS = 30_000;

/**
 * Bootstrap Helia, discover relays, and wire up the
 * multi-relay awareness room. Returns everything
 * create-doc needs for P2P networking.
 */
export async function setupP2PLayer(
  opts: P2PLayerOptions,
): Promise<P2PLayerResult> {
  const {
    appId,
    networkId,
    ipnsName,
    channelKeys,
    signalingUrls,
    awareness,
    bootstrapPeers,
    rtcIceServers,
  } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let blockstore: any;
  if (!isHeliaLive()) {
    const { IDBBlockstore } = await import("blockstore-idb");
    const bs = new IDBBlockstore(`pokapali:blocks:${appId}`);
    await bs.open();
    blockstore = bs;
  }

  await acquireHelia({ bootstrapPeers, blockstore, networkId });

  try {
    const pubsub = getHeliaPubsub() as unknown as PubSubLike;
    acquireNodeRegistry(pubsub, () => getHelia(), networkId);

    const syncOpts: SyncOptions = {
      peerOpts: {
        config: {
          iceServers: rtcIceServers ?? DEFAULT_ICE_SERVERS,
        },
      },
      pubsub,
    };

    const syncManager = setupNamespaceRooms(
      ipnsName,
      channelKeys,
      signalingUrls,
      syncOpts,
    );

    const helia = getHelia();
    const roomDiscovery = startRoomDiscovery(helia, appId);

    // Bootstrap peers are dialed by libp2p but
    // peer-discovery doesn't know they're relays.
    // Feed them as external relays so they get
    // tracked in relayPeerIds.
    if (bootstrapPeers?.length) {
      const entries = bootstrapPeers
        .map((addr) => {
          const m = addr.match(/\/p2p\/([^/]+)$/);
          return m ? { peerId: m[1], addrs: [addr] } : null;
        })
        .filter(
          (
            e,
          ): e is {
            peerId: string;
            addrs: string[];
          } => e !== null,
        );
      if (entries.length > 0) {
        roomDiscovery.addExternalRelays(entries);
      }
    }

    // Multi-relay room: wraps N per-relay awareness
    // rooms behind a single interface. Relays are
    // added/removed dynamically. Use pre-created
    // room if provided (allows early listener
    // registration).
    const multiRoom = opts.multiRoom ?? createMultiRelayRoom(awareness);

    log.info("waiting for relay discovery...");

    // Concurrency gate: only one trySignaling runs
    // at a time; later requests queue up.
    let signalingInFlight = false;
    let pendingRelay: string | null = null;

    function connectRelay(relayPid: string): void {
      if (signalingInFlight) {
        log.info("signaling in flight, queuing relay:", relayPid.slice(0, 12));
        pendingRelay = relayPid;
        return;
      }
      signalingInFlight = true;
      pendingRelay = null;
      log.info("connecting relay:", relayPid.slice(0, 12));
      void trySignaling(
        helia,
        relayPid,
        ipnsName,
        awareness,
        syncOpts,
        networkId,
      )
        .then((room) => {
          multiRoom.addRelay(relayPid, room);
        })
        .catch((err) => {
          log.warn("relay signaling failed:", (err as Error)?.message ?? err);
        })
        .finally(() => {
          signalingInFlight = false;
          if (pendingRelay) {
            const next = pendingRelay;
            pendingRelay = null;
            connectRelay(next);
          }
        });
    }

    // Initial relay: try to connect within the
    // timeout. If it fails, connectRelay will retry
    // when relays appear.
    try {
      const relayPid = await roomDiscovery.waitForRelay(RELAY_WAIT_MS);
      log.info("relay discovered:", relayPid.slice(0, 12));
      const room = await trySignaling(
        helia,
        relayPid,
        ipnsName,
        awareness,
        syncOpts,
        networkId,
      );
      multiRoom.addRelay(relayPid, room);
    } catch (err) {
      log.warn(
        "initial relay failed, will retry:",
        (err as Error)?.message ?? err,
      );
    }

    // New/reconnected relays → connect and add.
    roomDiscovery.onRelayReconnected(connectRelay);

    function requestReconnect(): void {
      // Pick the first connected relay and route
      // through connectRelay so the concurrency
      // gate serializes it.
      const conns = helia.libp2p.getConnections();
      const relayPid = [...roomDiscovery.relayPeerIds].find((pid) =>
        conns.some((c) => c.remotePeer.toString() === pid),
      );
      if (!relayPid) {
        log.warn("requestReconnect: no connected" + " relay available");
        return;
      }
      log.info("requestReconnect: trying relay:", relayPid.slice(0, 12));
      connectRelay(relayPid);
    }

    return {
      pubsub,
      syncManager,
      awarenessRoom: multiRoom,
      roomDiscovery,
      requestReconnect,
      closeBlockstore: blockstore ? () => blockstore.close() : undefined,
    };
  } catch (err) {
    releaseHelia();
    if (blockstore) blockstore.close();
    throw err;
  }
}

// --- Signaling helper ---

async function trySignaling(
  helia: ReturnType<typeof getHelia>,
  relayPid: string,
  ipnsName: string,
  awareness: Awareness,
  syncOpts: SyncOptions,
  networkId: string,
): Promise<AwarenessRoom> {
  const localPeerId = helia.libp2p.peerId.toString();
  const conn = helia.libp2p
    .getConnections()
    .find((c) => c.remotePeer.toString() === relayPid);
  if (!conn) {
    throw new Error("relay connection lost: " + relayPid.slice(0, 12));
  }

  log.info("opening signaling stream to:", relayPid.slice(0, 12));
  const stream = await helia.libp2p.dialProtocol(
    conn.remotePeer,
    SIGNALING_PROTOCOL,
  );

  const client = createSignalingClient(stream as unknown as SignalingStream);
  log.info(
    "signaling connected to relay:",
    relayPid.slice(0, 12),
    "localPeer:",
    localPeerId.slice(0, 12),
    "doc:",
    ipnsName.slice(0, 12),
  );

  const rtcConfig = syncOpts.peerOpts?.config;
  return setupSignaledAwarenessRoom(ipnsName, localPeerId, client, awareness, {
    rtcConfig,
    networkId,
  });
}
