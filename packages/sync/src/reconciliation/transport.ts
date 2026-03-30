/**
 * Transport layer for reconciliation messages over
 * a WebRTC data channel.
 *
 * Frame format (binary):
 *   [channelNameLength: uint16 big-endian]
 *   [channelName: utf8 bytes]
 *   [messageBytes: rest]
 *
 * @module
 */

import { encodeMessage, decodeMessage, type Message } from "./messages.js";

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

  const messageCallbacks = new Set<
    (channelName: string, msg: Message) => void
  >();
  const connectionCallbacks = new Set<(connected: boolean) => void>();

  function onDCMessage(event: MessageEvent): void {
    if (destroyed) return;
    const frame = new Uint8Array(event.data as ArrayBuffer);
    const { channelName, message } = decodeFrame(frame);
    console.log(
      "[P2P-DIAG] transport recv:",
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
    for (const cb of connectionCallbacks) {
      cb(false);
    }
  }

  function onDCOpen(): void {
    if (destroyed) return;
    for (const cb of connectionCallbacks) {
      cb(true);
    }
  }

  dataChannel.addEventListener("message", onDCMessage as EventListener);
  dataChannel.addEventListener("close", onDCClose as EventListener);
  dataChannel.addEventListener("open", onDCOpen as EventListener);

  return {
    send(channelName: string, msg: Message): void {
      const frame = encodeFrame(channelName, msg);
      console.log(
        "[P2P-DIAG] transport send:",
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
