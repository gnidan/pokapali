/**
 * Reconciliation wiring — connects coordinators to
 * a transport for each document channel.
 *
 * Creates one ReconciliationCoordinator per channel,
 * routes incoming transport messages to the correct
 * coordinator, and applies received edits/snapshots
 * to the channel's epoch tree.
 *
 * @module
 */

import type { Channel, Edit } from "@pokapali/document";
import { State, Cache, foldTree } from "@pokapali/document";
import type { Codec } from "@pokapali/codec";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import {
  createCoordinator,
  ReconciliationMessageType,
  type ReconciliationTransport,
  type ReconciliationCoordinator,
  type ReconciliationMessage,
} from "@pokapali/sync";
import {
  signEdit,
  verifyEdit,
  ENVELOPE_VERSION,
  HEADER_SIZE,
} from "./epoch/sign-edit.js";

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export interface ReconciliationWiringOptions {
  channels: string[];
  getChannel: (name: string) => Channel;
  codec: Codec;
  transport: ReconciliationTransport;
  trustedKeys?: Set<string>;
  /** Identity keypair for signing outgoing edits.
   *  When provided, EDIT_BATCH messages are signed
   *  with a 97-byte envelope before sending. */
  identity?: Ed25519KeyPair;
  /** Called after a remote edit is applied to the
   *  epoch tree. Use this to apply the edit payload
   *  to the Y.Doc so it appears in the editor. */
  onRemoteEdit?: (channelName: string, edit: Edit) => void;
}

export interface ReconciliationWiring {
  /** Trigger reconciliation for all channels.
   *  Call when transport connects or fingerprint
   *  changes. */
  reconcile(): void;
  destroy(): void;
}

// -------------------------------------------------------
// Implementation
// -------------------------------------------------------

export function createReconciliationWiring(
  opts: ReconciliationWiringOptions,
): ReconciliationWiring {
  const coordinators = new Map<string, ReconciliationCoordinator>();

  // Listen for incoming messages immediately so
  // we're ready to receive before either side starts.
  const unsubTransport = opts.transport.onMessage(
    (channelName: string, msg: ReconciliationMessage) => {
      coordinators.get(channelName)?.receive(msg);
    },
  );

  function reconcile(): void {
    coordinators.clear();

    const measured = State.channelMeasured(opts.codec);

    for (const ch of opts.channels) {
      const channel = opts.getChannel(ch);

      // Compute snapshot for FULL_STATE (late joiner)
      const cache = Cache.create<Uint8Array>();
      const snapshot = foldTree<Uint8Array>(measured, channel.tree, cache);

      const coordinator = createCoordinator({
        channel,
        channelName: ch,
        sender: {
          send: (msg) => {
            // Sign outgoing EDIT_BATCH payloads when
            // identity is available.
            if (
              opts.identity &&
              msg.type === ReconciliationMessageType.EDIT_BATCH
            ) {
              const kp = opts.identity;
              void Promise.all(
                msg.edits.map(async (e) => ({
                  payload: e.payload,
                  signature: await signEdit(e.payload, kp),
                })),
              )
                .then((signed) => {
                  opts.transport.send(ch, {
                    ...msg,
                    edits: signed,
                  });
                })
                .catch(() => {
                  // Signing failed — drop silently.
                  // Transport may have disconnected.
                });
              return;
            }
            opts.transport.send(ch, msg);
          },
        },
        applier: {
          apply: (edit) => {
            // Re-tag origin as "sync" so the
            // Document's surface editListener
            // recognizes it as remote and forwards
            // to the surface Y.Doc. Edits arrive
            // with origin "local" (set by the
            // sender's edit bridge) but on the
            // receiving side they must be treated
            // as remote.
            const sig = edit.signature;

            // Try envelope format: 97-byte header
            // with version byte. Fall back to raw
            // for mixed-version peers.
            if (sig.length >= HEADER_SIZE && sig[0] === ENVELOPE_VERSION) {
              void verifyEdit(sig, opts.trustedKeys)
                .then((result) => {
                  if (!result) return; // bad sig
                  const remoteEdit: Edit = {
                    ...edit,
                    origin: "sync",
                    signature: sig,
                  };
                  channel.appendEdit(remoteEdit);
                  opts.onRemoteEdit?.(ch, remoteEdit);
                })
                .catch(() => {
                  // Verification error — drop.
                });
              return;
            }

            // Raw/legacy signature — pass through.
            const remoteEdit: Edit = {
              ...edit,
              origin: "sync",
            };
            channel.appendEdit(remoteEdit);
            opts.onRemoteEdit?.(ch, remoteEdit);
          },
          applySnapshot: (s) => channel.appendSnapshot(s),
        },
        trustedKeys: opts.trustedKeys,
        verifySig: opts.trustedKeys
          ? async (sig) => {
              const result = await verifyEdit(sig, opts.trustedKeys);
              return result?.payload ?? null;
            }
          : undefined,
        localSnapshot: snapshot.length > 0 ? snapshot : undefined,
      });

      coordinators.set(ch, coordinator);
      coordinator.start();
    }
  }

  function destroy(): void {
    unsubTransport();
    coordinators.clear();
  }

  return { reconcile, destroy };
}
