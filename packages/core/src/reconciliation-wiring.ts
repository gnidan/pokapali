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
import {
  createCoordinator,
  type ReconciliationTransport,
  type ReconciliationCoordinator,
  type ReconciliationMessage,
} from "@pokapali/sync";

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export interface ReconciliationWiringOptions {
  channels: string[];
  getChannel: (name: string) => Channel;
  codec: Codec;
  transport: ReconciliationTransport;
  trustedKeys?: Set<string>;
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
          send: (msg) => opts.transport.send(ch, msg),
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
