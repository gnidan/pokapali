/**
 * Relay-to-relay forwarding for signaling messages.
 *
 * When a browser joins a room on relay A, relay A
 * broadcasts the join via GossipSub so relay B adds
 * a virtual peer entry. Signals to remote peers are
 * forwarded through the GossipSub mesh.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import {
  createEncoder,
  writeVarUint,
  writeVarString,
  writeVarUint8Array,
  toUint8Array,
} from "lib0/encoding";
import {
  createDecoder,
  readVarUint,
  readVarString,
  readVarUint8Array,
} from "lib0/decoding";
import { SignalType, encodeSignal } from "./protocol.js";
import type { RoomRegistry } from "./registry.js";

const log = createLogger("relay-fwd");

// -------------------------------------------------------
// GossipSub topic
// -------------------------------------------------------

export function relaySignalingTopic(networkId: string): string {
  return `/pokapali/${networkId}/signaling/relay`;
}

/** @deprecated Use relaySignalingTopic(networkId). */
export const RELAY_SIGNALING_TOPIC = relaySignalingTopic("main");

// -------------------------------------------------------
// Relay message types
// -------------------------------------------------------

const RelayMsgType = {
  JOIN: 0,
  LEAVE: 1,
  SIGNAL: 2,
} as const;

type RelayMsgType = (typeof RelayMsgType)[keyof typeof RelayMsgType];

interface RelayJoin {
  type: typeof RelayMsgType.JOIN;
  relayPeerId: string;
  room: string;
  peerId: string;
}

interface RelayLeave {
  type: typeof RelayMsgType.LEAVE;
  relayPeerId: string;
  room: string;
  peerId: string;
}

interface RelaySignal {
  type: typeof RelayMsgType.SIGNAL;
  relayPeerId: string;
  room: string;
  targetPeerId: string;
  payload: Uint8Array;
}

type RelayMsg = RelayJoin | RelayLeave | RelaySignal;

// -------------------------------------------------------
// Encode / decode
// -------------------------------------------------------

export function encodeRelayMsg(msg: RelayMsg): Uint8Array {
  const enc = createEncoder();
  writeVarUint(enc, msg.type);
  writeVarString(enc, msg.relayPeerId);
  writeVarString(enc, msg.room);
  switch (msg.type) {
    case RelayMsgType.JOIN:
      writeVarString(enc, msg.peerId);
      break;
    case RelayMsgType.LEAVE:
      writeVarString(enc, msg.peerId);
      break;
    case RelayMsgType.SIGNAL:
      writeVarString(enc, msg.targetPeerId);
      writeVarUint8Array(enc, msg.payload);
      break;
  }
  return toUint8Array(enc);
}

export function decodeRelayMsg(bytes: Uint8Array): RelayMsg {
  const dec = createDecoder(bytes);
  const type = readVarUint(dec) as RelayMsgType;
  const relayPeerId = readVarString(dec);
  const room = readVarString(dec);
  switch (type) {
    case RelayMsgType.JOIN:
      return {
        type,
        relayPeerId,
        room,
        peerId: readVarString(dec),
      };
    case RelayMsgType.LEAVE:
      return {
        type,
        relayPeerId,
        room,
        peerId: readVarString(dec),
      };
    case RelayMsgType.SIGNAL:
      return {
        type,
        relayPeerId,
        room,
        targetPeerId: readVarString(dec),
        payload: readVarUint8Array(dec),
      };
    default:
      throw new Error(`Unknown relay message type: ${type}`);
  }
}

// -------------------------------------------------------
// PubSub interface (minimal subset)
// -------------------------------------------------------

export interface PubSubLike {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: Uint8Array): Promise<unknown>;
  addEventListener(
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (evt: any) => void,
  ): void;
  removeEventListener(
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (evt: any) => void,
  ): void;
}

// -------------------------------------------------------
// Forwarder
// -------------------------------------------------------

export interface RelayForwarder {
  /** Broadcast that a local browser joined a room */
  onLocalJoin(room: string, peerId: string): void;
  /** Broadcast that a local browser left a room */
  onLocalLeave(room: string, peerId: string): void;
  /** Check if a peerId is a remote (virtual) peer */
  isRemotePeer(peerId: string): boolean;
  /** Stop forwarding and clean up */
  stop(): void;
}

export function createRelayForwarder(
  pubsub: PubSubLike,
  selfRelayPeerId: string,
  registry: RoomRegistry,
  networkId = "main",
): RelayForwarder {
  const sigTopic = relaySignalingTopic(networkId);
  log.info(
    "forwarder subscribing to:",
    sigTopic,
    "self:",
    selfRelayPeerId.slice(0, 12),
  );
  pubsub.subscribe(sigTopic);

  // Track remote peers: peerId → Map<room, relayPeerId>
  // The relayPeerId tracks which relay "owns" the
  // remote peer so LEAVEs from the wrong relay are
  // ignored (e.g. peer moved between relays).
  const remotePeers = new Map<string, Map<string, string>>();

  function isRemote(peerId: string): boolean {
    return remotePeers.has(peerId);
  }

  /**
   * Track a remote peer in a room. Returns false
   * if already tracked on the SAME relay (dedup).
   * Overwrites if the peer moved to a different relay.
   */
  function addRemote(
    room: string,
    peerId: string,
    relayPeerId: string,
  ): boolean {
    let rooms = remotePeers.get(peerId);
    if (rooms?.get(room) === relayPeerId) return false;
    if (!rooms) {
      rooms = new Map();
      remotePeers.set(peerId, rooms);
    }
    rooms.set(room, relayPeerId);
    return true;
  }

  /**
   * Remove a remote peer. Only removes if the
   * relay matches (prevents stale LEAVE from
   * removing a peer that moved to a new relay).
   */
  function removeRemote(
    room: string,
    peerId: string,
    relayPeerId: string,
  ): boolean {
    const rooms = remotePeers.get(peerId);
    if (!rooms) return false;
    const owner = rooms.get(room);
    if (owner !== relayPeerId) return false;
    rooms.delete(room);
    if (rooms.size === 0) remotePeers.delete(peerId);
    return true;
  }

  function publish(msg: RelayMsg): void {
    pubsub.publish(sigTopic, encodeRelayMsg(msg)).catch(() => {});
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onGossipMessage(evt: any): void {
    const detail = evt.detail;
    if (detail.topic !== sigTopic) return;

    let msg: RelayMsg;
    try {
      msg = decodeRelayMsg(detail.data);
    } catch {
      return;
    }

    // Suppress own echo
    if (msg.relayPeerId === selfRelayPeerId) return;

    switch (msg.type) {
      case RelayMsgType.JOIN:
        handleRemoteJoin(msg);
        break;
      case RelayMsgType.LEAVE:
        handleRemoteLeave(msg);
        break;
      case RelayMsgType.SIGNAL:
        handleRemoteSignal(msg);
        break;
    }
  }

  function handleRemoteJoin(msg: RelayJoin): void {
    if (!addRemote(msg.room, msg.peerId, msg.relayPeerId)) return;

    log.info(
      "remote join:",
      msg.peerId.slice(0, 12),
      msg.room,
      "via",
      msg.relayPeerId.slice(0, 12),
    );

    // Snapshot local members BEFORE adding virtual
    // entry (so we don't re-broadcast the joiner)
    const localMembers = registry
      .members(msg.room)
      .filter((m) => !isRemote(m.peerId));

    // Notify local members about remote peer
    const joinedBytes = encodeSignal({
      type: SignalType.PEER_JOINED,
      room: msg.room,
      peerId: msg.peerId,
    });
    for (const member of localMembers) {
      member.send(joinedBytes);
    }

    // Add virtual entry — signals to this peer
    // get forwarded via GossipSub
    registry.join(msg.room, {
      peerId: msg.peerId,
      send: (bytes: Uint8Array) => {
        publish({
          type: RelayMsgType.SIGNAL,
          relayPeerId: selfRelayPeerId,
          room: msg.room,
          targetPeerId: msg.peerId,
          payload: bytes,
        });
      },
    });

    // Tell the remote relay about our local members
    // so the joining peer discovers them
    for (const member of localMembers) {
      publish({
        type: RelayMsgType.JOIN,
        relayPeerId: selfRelayPeerId,
        room: msg.room,
        peerId: member.peerId,
      });
    }
  }

  function handleRemoteLeave(msg: RelayLeave): void {
    if (!removeRemote(msg.room, msg.peerId, msg.relayPeerId)) return;

    log.info(
      "remote leave:",
      msg.peerId.slice(0, 12),
      msg.room,
      "via",
      msg.relayPeerId.slice(0, 12),
    );

    registry.leave(msg.room, msg.peerId);

    // Notify local members
    const leftBytes = encodeSignal({
      type: SignalType.PEER_LEFT,
      room: msg.room,
      peerId: msg.peerId,
    });
    for (const member of registry.members(msg.room)) {
      if (!isRemote(member.peerId)) {
        member.send(leftBytes);
      }
    }
  }

  function handleRemoteSignal(msg: RelaySignal): void {
    const target = registry.findPeer(msg.room, msg.targetPeerId);
    if (target && !isRemote(msg.targetPeerId)) {
      target.send(msg.payload);
    }
  }

  pubsub.addEventListener("message", onGossipMessage);

  return {
    onLocalJoin(room: string, peerId: string): void {
      // If this peer was previously tracked as remote
      // (e.g. moved between relays), clear remote
      // tracking so stale LEAVEs don't remove the
      // now-local entry.
      const rooms = remotePeers.get(peerId);
      if (rooms) {
        rooms.delete(room);
        if (rooms.size === 0) remotePeers.delete(peerId);
      }

      log.info(
        "local join →",
        peerId.slice(0, 12),
        room,
        "remotePeers:",
        remotePeers.size,
      );

      publish({
        type: RelayMsgType.JOIN,
        relayPeerId: selfRelayPeerId,
        room,
        peerId,
      });
    },

    onLocalLeave(room: string, peerId: string): void {
      log.info("local leave →", peerId.slice(0, 12), room);

      publish({
        type: RelayMsgType.LEAVE,
        relayPeerId: selfRelayPeerId,
        room,
        peerId,
      });
    },

    isRemotePeer: isRemote,

    stop(): void {
      pubsub.removeEventListener("message", onGossipMessage);
      pubsub.unsubscribe(sigTopic);
      remotePeers.clear();
    },
  };
}
