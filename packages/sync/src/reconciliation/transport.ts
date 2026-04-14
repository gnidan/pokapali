/**
 * Transport layer for reconciliation messages over
 * a WebRTC data channel.
 *
 * Frame format (binary):
 *   [channelNameLength: uint16 big-endian]
 *   [channelName: utf8 bytes]
 *   [messageBytes: rest]
 *
 * Keepalive: 1-byte frames (0x01 = PING, 0x02 = PONG)
 * prevent NAT/firewall timeout during idle periods.
 * Too short to be valid reconciliation frames, so
 * they're handled before decoding.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import { encodeMessage, decodeMessage, type Message } from "./messages.js";

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
  send(channelName: string, msg: Message): void;
  onMessage(cb: (channelName: string, msg: Message) => void): () => void;
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

    onMessage(cb: (channelName: string, msg: Message) => void): () => void {
      messageCallbacks.add(cb);
      return () => messageCallbacks.delete(cb);
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
