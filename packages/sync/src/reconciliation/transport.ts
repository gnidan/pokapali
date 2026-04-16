/**
 * Transport layer for reconciliation messages over
 * a WebRTC data channel.
 *
 * Frame format (binary):
 *   [channelNameLength: uint16 big-endian]
 *   [channelName: utf8 bytes]
 *   [messageBytes: rest]
 *
 * channelNameLength === 0 indicates a "snapshot
 * frame": the message is a per-document snapshot
 * exchange message (types 6/7/8) with no associated
 * channel. Snapshot CIDs span all channels, so these
 * messages live outside the per-channel edit loop.
 *
 * Keepalive: 1-byte frames (0x01 = PING, 0x02 = PONG)
 * prevent NAT/firewall timeout during idle periods.
 * Too short to be valid reconciliation frames, so
 * they're handled before decoding.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import {
  encodeMessage,
  decodeMessage,
  MessageType,
  type Message,
} from "./messages.js";

/**
 * Subset of Message limited to snapshot exchange
 * types (no `channel` field).
 */
export type SnapshotMessage = Extract<
  Message,
  {
    type:
      | typeof MessageType.SNAPSHOT_CATALOG
      | typeof MessageType.SNAPSHOT_REQUEST
      | typeof MessageType.SNAPSHOT_BLOCK;
  }
>;

function isSnapshotMessage(msg: Message): msg is SnapshotMessage {
  return (
    msg.type === MessageType.SNAPSHOT_CATALOG ||
    msg.type === MessageType.SNAPSHOT_REQUEST ||
    msg.type === MessageType.SNAPSHOT_BLOCK
  );
}

const diagLog = createLogger("p2p-diag");

// Keepalive: 1-byte frames below the reconciliation
// message layer. Sent periodically to prevent
// NAT/firewall timeout on idle data channels.
const KEEPALIVE_PING = new Uint8Array([0x01]);
const KEEPALIVE_PONG = new Uint8Array([0x02]);
// 20s interval — well under typical NAT timeouts
// (30s–5min) and TURN relay timeouts (5min).
const KEEPALIVE_INTERVAL_MS = 20_000;

// -------------------------------------------------------
// Frame encoding / decoding
// -------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(channelName: string, msg: Message): Uint8Array {
  const nameBytes = encoder.encode(channelName);
  const msgBytes = encodeMessage(msg);
  const frame = new Uint8Array(2 + nameBytes.length + msgBytes.length);
  frame[0] = (nameBytes.length >> 8) & 0xff;
  frame[1] = nameBytes.length & 0xff;
  frame.set(nameBytes, 2);
  frame.set(msgBytes, 2 + nameBytes.length);
  return frame;
}

/**
 * Encode a snapshot frame. Uses the same wire format
 * as channel frames but with channelNameLength=0.
 * The receiver distinguishes snapshot frames from
 * channel frames by the zero-length prefix.
 */
export function encodeSnapshotFrame(msg: SnapshotMessage): Uint8Array {
  const msgBytes = encodeMessage(msg);
  const frame = new Uint8Array(2 + msgBytes.length);
  // channelNameLength = 0
  frame[0] = 0;
  frame[1] = 0;
  frame.set(msgBytes, 2);
  return frame;
}

export function decodeFrame(frame: Uint8Array): {
  channelName: string;
  message: Message;
} {
  const nameLen = (frame[0]! << 8) | frame[1]!;
  const channelName = decoder.decode(frame.subarray(2, 2 + nameLen));
  const message = decodeMessage(frame.subarray(2 + nameLen));
  return { channelName, message };
}

// -------------------------------------------------------
// Transport interface
// -------------------------------------------------------

export interface ReconciliationTransport {
  /** Send a per-channel edit-reconciliation message. */
  send(channelName: string, msg: Message): void;
  /** Send a per-document snapshot-exchange message. */
  sendSnapshotMessage(msg: SnapshotMessage): void;
  /** Inbound per-channel edit-reconciliation messages. */
  onMessage(cb: (channelName: string, msg: Message) => void): () => void;
  /** Inbound per-document snapshot-exchange messages. */
  onSnapshotMessage(cb: (msg: SnapshotMessage) => void): () => void;
  readonly connected: boolean;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  destroy(): void;
}

// -------------------------------------------------------
// Transport implementation
// -------------------------------------------------------

export function createTransport(
  dataChannel: RTCDataChannel,
): ReconciliationTransport {
  let destroyed = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const messageCallbacks = new Set<
    (channelName: string, msg: Message) => void
  >();
  const snapshotCallbacks = new Set<(msg: SnapshotMessage) => void>();
  const connectionCallbacks = new Set<(connected: boolean) => void>();

  function startKeepalive(): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (dataChannel.readyState === "open") {
        dataChannel.send(KEEPALIVE_PING as ArrayBufferView<ArrayBuffer>);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  function stopKeepalive(): void {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function onDCMessage(event: MessageEvent): void {
    if (destroyed) return;
    const frame = new Uint8Array(event.data as ArrayBuffer);
    // Keepalive: 1-byte frames handled before
    // reconciliation message decoding.
    if (frame.length === 1) {
      if (frame[0] === KEEPALIVE_PING[0]) {
        dataChannel.send(KEEPALIVE_PONG as ArrayBufferView<ArrayBuffer>);
      }
      // PONG (or unknown 1-byte) — no action needed,
      // receiving it already kept the NAT alive.
      return;
    }
    const { channelName, message } = decodeFrame(frame);
    // Zero-length channel = snapshot frame (per-document,
    // no channel). Dispatch to snapshot callbacks.
    if (channelName === "") {
      if (!isSnapshotMessage(message)) {
        diagLog.debug(
          "transport recv: dropping non-snapshot message",
          "in snapshot frame, type=",
          message.type,
        );
        return;
      }
      diagLog.debug(
        "transport recv snapshot:",
        "type=",
        message.type,
        "size=",
        frame.length,
      );
      for (const cb of snapshotCallbacks) {
        cb(message);
      }
      return;
    }
    // Defensive: snapshot-typed messages in a channel
    // frame are a routing violation; drop them rather
    // than fan out to session.ts which would throw.
    if (isSnapshotMessage(message)) {
      diagLog.debug(
        "transport recv: dropping snapshot message",
        "in channel frame, channel=",
        channelName,
        "type=",
        message.type,
      );
      return;
    }
    diagLog.debug(
      "transport recv:",
      channelName,
      "type=",
      message.type,
      "size=",
      frame.length,
    );
    for (const cb of messageCallbacks) {
      cb(channelName, message);
    }
  }

  function onDCClose(): void {
    if (destroyed) return;
    stopKeepalive();
    for (const cb of connectionCallbacks) {
      cb(false);
    }
  }

  function onDCOpen(): void {
    if (destroyed) return;
    startKeepalive();
    for (const cb of connectionCallbacks) {
      cb(true);
    }
  }

  dataChannel.addEventListener("message", onDCMessage as EventListener);
  dataChannel.addEventListener("close", onDCClose as EventListener);
  dataChannel.addEventListener("open", onDCOpen as EventListener);

  // If already open (initiator side), start now.
  if (dataChannel.readyState === "open") {
    startKeepalive();
  }

  return {
    send(channelName: string, msg: Message): void {
      if (channelName === "") {
        throw new Error("transport.send: channelName must be non-empty");
      }
      if (isSnapshotMessage(msg)) {
        throw new Error(
          `transport.send: use sendSnapshotMessage for type ${msg.type}`,
        );
      }
      const frame = encodeFrame(channelName, msg);
      diagLog.debug(
        "transport send:",
        channelName,
        "type=",
        msg.type,
        "size=",
        frame.length,
      );
      dataChannel.send(frame as ArrayBufferView<ArrayBuffer>);
    },

    sendSnapshotMessage(msg: SnapshotMessage): void {
      const frame = encodeSnapshotFrame(msg);
      diagLog.debug(
        "transport send snapshot:",
        "type=",
        msg.type,
        "size=",
        frame.length,
      );
      dataChannel.send(frame as ArrayBufferView<ArrayBuffer>);
    },

    onMessage(cb: (channelName: string, msg: Message) => void): () => void {
      messageCallbacks.add(cb);
      return () => messageCallbacks.delete(cb);
    },

    onSnapshotMessage(cb: (msg: SnapshotMessage) => void): () => void {
      snapshotCallbacks.add(cb);
      return () => snapshotCallbacks.delete(cb);
    },

    get connected(): boolean {
      return dataChannel.readyState === "open";
    },

    onConnectionChange(cb: (connected: boolean) => void): () => void {
      connectionCallbacks.add(cb);
      return () => connectionCallbacks.delete(cb);
    },

    destroy(): void {
      destroyed = true;
      stopKeepalive();
      messageCallbacks.clear();
      snapshotCallbacks.clear();
      connectionCallbacks.clear();
      dataChannel.removeEventListener("message", onDCMessage as EventListener);
      dataChannel.removeEventListener("close", onDCClose as EventListener);
      dataChannel.removeEventListener("open", onDCOpen as EventListener);
    },
  };
}

// -------------------------------------------------------
// Data channel creation
// -------------------------------------------------------

export function createReconcileChannel(
  peerConnection: RTCPeerConnection,
): RTCDataChannel {
  return peerConnection.createDataChannel("pokapali-reconcile", {
    ordered: true,
  });
}
