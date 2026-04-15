/**
 * Peer sync orchestration — manages reconciliation
 * wirings and live edit forwarding across WebRTC
 * data channels.
 *
 * Extracted from create-doc.ts to reduce its size.
 * Pure orchestration: delegates to reconciliation-wiring
 * for the actual coordinator/protocol work.
 *
 * @module
 */

import type { Document, Edit } from "@pokapali/document";
import type { Codec } from "@pokapali/codec";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import {
  createReconcileChannel,
  createTransport,
  ReconciliationMessageType,
} from "@pokapali/sync";
import {
  createReconciliationWiring,
  type ReconciliationWiring,
} from "./reconciliation-wiring.js";
import { signEdit } from "./epoch/sign-edit.js";

// ── Options ────────────────────────────────────

export interface PeerSyncOptions {
  channels: string[];
  document: Document;
  codec: Codec;
  identity?: Ed25519KeyPair;
  /** Called after a remote edit is persisted to the
   *  epoch tree (both reconciliation and live). */
  persistEdit: (channelName: string, edit: Edit) => void;
  /** Called when aggregate sync connectivity changes
   *  (first peer connects / last peer disconnects). */
  onSyncStatusChanged?: (status: "connected" | "disconnected") => void;
}

// ── Return type ────────────────────────────────

export interface PeerSync {
  /** Debounced reconciliation trigger — call when
   *  local edits arrive so peers catch up. */
  scheduleReconcile(): void;
  /** Wire a new peer connection for reconciliation
   *  and live edit forwarding. Creates the data
   *  channel (initiator) or listens for it
   *  (responder). */
  wirePeerConnection(pc: RTCPeerConnection, initiator: boolean): void;
  destroy(): void;
}

// ── Factory ────────────────────────────────────

export function createPeerSync(opts: PeerSyncOptions): PeerSync {
  const {
    channels,
    document: doc,
    codec,
    identity,
    persistEdit,
    onSyncStatusChanged,
  } = opts;

  const wirings = new Set<ReconciliationWiring>();
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  // ── Debounced reconcile ──────────────────────

  function scheduleReconcile(): void {
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      for (const w of wirings) {
        w.reconcile();
      }
    }, 100);
  }

  // ── Data channel wiring ──────────────────────

  function wireDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";

    const transport = createTransport(dc);
    const wiring = createReconciliationWiring({
      channels,
      getChannel: (name) => doc.channel(name),
      codec,
      transport,
      identity,
      onRemoteEdit: (ch, edit) => {
        persistEdit(ch, edit);
      },
    });
    wirings.add(wiring);

    // Bridge transport connectivity → caller.
    const unsubConn = transport.onConnectionChange((connected) => {
      onSyncStatusChanged?.(connected ? "connected" : "disconnected");
    });

    // Live edit forwarding: forward local edits
    // to the peer and apply incoming edits.
    const editUnsubs: Array<() => void> = [];

    function startLiveForwarding(): void {
      for (const ch of channels) {
        const unsub = doc.onEdit(ch, (edit) => {
          // Only forward local edits — remote
          // edits (origin "sync") are already
          // on the peer.
          if (edit.origin !== "local") return;
          if (!transport.connected) return;
          // Sign on-the-fly: produce a 97-byte
          // envelope for the wire. Signing is
          // async (~0.23ms) so we fire-and-forget.
          if (identity) {
            void signEdit(edit.payload, identity)
              .then((envelope) => {
                if (!transport.connected) return;
                transport.send(ch, {
                  type: ReconciliationMessageType.EDIT_BATCH,
                  channel: ch,
                  edits: [
                    {
                      payload: edit.payload,
                      signature: envelope,
                    },
                  ],
                });
              })
              .catch(() => {
                // Signing failed — drop silently.
              });
          } else {
            transport.send(ch, {
              type: ReconciliationMessageType.EDIT_BATCH,
              channel: ch,
              edits: [
                {
                  payload: edit.payload,
                  signature: edit.signature,
                },
              ],
            });
          }
        });
        editUnsubs.push(unsub);
      }
    }

    // Handle incoming live edits (EDIT_BATCH
    // messages that arrive after initial
    // reconciliation).
    const unsubLiveEdits = transport.onMessage((channelName, msg) => {
      if (msg.type !== ReconciliationMessageType.EDIT_BATCH) {
        return;
      }
      const channel = doc.channel(channelName);
      for (const e of msg.edits) {
        const edit = {
          payload: e.payload,
          timestamp: Date.now(),
          author: "",
          channel: channelName,
          origin: "sync" as const,
          signature: e.signature,
        };
        channel.appendEdit(edit);
        persistEdit(channelName, edit);
      }
    });

    // Start reconciliation when channel opens.
    if (dc.readyState === "open") {
      wiring.reconcile();
      startLiveForwarding();
    } else {
      dc.addEventListener("open", () => {
        if (!wirings.has(wiring)) return;
        wiring.reconcile();
        startLiveForwarding();
      });
    }

    function cleanup() {
      for (const unsub of editUnsubs) unsub();
      editUnsubs.length = 0;
      unsubLiveEdits();
      unsubConn();
      wiring.destroy();
      wirings.delete(wiring);
      // If no transports remain, notify caller.
      if (wirings.size === 0) {
        onSyncStatusChanged?.("disconnected");
      }
    }

    dc.addEventListener("close", cleanup);
    dc.addEventListener("error", cleanup);
  }

  // ── Peer connection handler ──────────────────

  function wirePeerConnection(pc: RTCPeerConnection, initiator: boolean): void {
    if (destroyed) return;

    // Initiator creates the data channel before
    // the SDP offer so it's in the negotiation.
    if (initiator) {
      wireDataChannel(createReconcileChannel(pc));
    }

    // Both sides listen for incoming data
    // channels (responder receives the
    // initiator's channel).
    pc.addEventListener("datachannel", (event) => {
      if (event.channel.label === "pokapali-reconcile") {
        wireDataChannel(event.channel);
      }
    });
  }

  // ── Destroy ──────────────────────────────────

  function destroy(): void {
    destroyed = true;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    for (const w of wirings) w.destroy();
    wirings.clear();
  }

  return { scheduleReconcile, wirePeerConnection, destroy };
}
