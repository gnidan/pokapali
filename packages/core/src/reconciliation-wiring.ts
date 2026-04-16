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
import { CID, sha256, validateSnapshot } from "@pokapali/blocks";
import {
  createCoordinator,
  createSnapshotExchange,
  ReconciliationMessageType,
  type ReconciliationTransport,
  type ReconciliationCoordinator,
  type ReconciliationMessage,
  type SnapshotCatalogEntry,
  type SnapshotExchange,
} from "@pokapali/sync";
import {
  signEdit,
  verifyEdit,
  ENVELOPE_VERSION,
  HEADER_SIZE,
} from "./epoch/sign-edit.js";
import type { BlockResolver } from "./block-resolver.js";

// -------------------------------------------------------
// Types
// -------------------------------------------------------

/** Snapshot catalog as advertised to peers. */
export interface SnapshotCatalog {
  entries: SnapshotCatalogEntry[];
  tip: Uint8Array | null;
}

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
  /** Snapshot catalog provider. When supplied together
   *  with {@link blockResolver}, per-document snapshot
   *  exchange is enabled: the catalog is advertised
   *  once per reconcile cycle after all per-channel
   *  coordinators report done, and incoming blocks are
   *  verified (CID hash + `validateSnapshot`) before
   *  being stored via `blockResolver.put()`. */
  getSnapshotCatalog?: () => SnapshotCatalog;
  /** Block store used both to serve snapshot requests
   *  (`getCached`) and to persist verified blocks
   *  received from peers (`put`). */
  blockResolver?: BlockResolver;
  /** Called after a peer snapshot block has been
   *  verified and stored. Use this to surface the
   *  block to the UI (e.g. trigger tip/version update
   *  or decrypted snapshot application). */
  onSnapshotReceived?: (cid: CID, data: Uint8Array) => void;
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

  // Per-document snapshot exchange. Set up once, up
  // front — the peer may advertise their catalog at
  // any time, independent of per-channel edit reconcile
  // progress. We only advertise OUR catalog after all
  // coordinators report done (per-document, peer of
  // coordinator). Trust model is owned here: core
  // verifies CID hash + `validateSnapshot` before
  // `blockResolver.put()`.
  let snapshotExchange: SnapshotExchange | null = null;
  let unsubSnapshot: (() => void) | null = null;
  let snapshotAdvertised = false;

  if (opts.getSnapshotCatalog && opts.blockResolver) {
    const resolver = opts.blockResolver;
    const catalogFn = opts.getSnapshotCatalog;
    snapshotExchange = createSnapshotExchange({
      send: (msg) => opts.transport.sendSnapshotMessage(msg),
      getLocalCatalog: () => catalogFn(),
      getBlock: (cidBytes) => {
        try {
          return resolver.getCached(CID.decode(cidBytes));
        } catch {
          return null;
        }
      },
      onBlock: (cidBytes, data) => {
        let cid: CID;
        try {
          cid = CID.decode(cidBytes);
        } catch {
          return;
        }
        resolver.put(cid, data);
        opts.onSnapshotReceived?.(cid, data);
      },
      // Core owns the trust model: CID hash must match
      // sha256(data) AND `validateSnapshot` must pass
      // (checks doc and publisher signatures).
      verify: async (cidBytes, data) => {
        let cid: CID;
        try {
          cid = CID.decode(cidBytes);
        } catch {
          return false;
        }
        const hash = await sha256.digest(data);
        if (!bytesEqual(cid.multihash.digest, hash.digest)) {
          return false;
        }
        return await validateSnapshot(data);
      },
    });
    unsubSnapshot = opts.transport.onSnapshotMessage((msg) =>
      snapshotExchange!.receive(msg),
    );
  }

  function maybeAdvertiseSnapshots(): void {
    if (!snapshotExchange || snapshotAdvertised) return;
    if (coordinators.size === 0) return;
    for (const c of coordinators.values()) {
      if (!c.done) return;
    }
    snapshotAdvertised = true;
    snapshotExchange.advertise();
  }

  // Listen for incoming messages immediately so
  // we're ready to receive before either side starts.
  const unsubTransport = opts.transport.onMessage(
    (channelName: string, msg: ReconciliationMessage) => {
      coordinators.get(channelName)?.receive(msg);
      // `done` can only transition on receive; check
      // here so snapshot advertise fires as soon as
      // the last coordinator completes.
      maybeAdvertiseSnapshots();
    },
  );

  function reconcile(): void {
    coordinators.clear();
    // New reconcile cycle — re-advertise the catalog
    // once it completes (local state may have changed
    // since the last advertise).
    snapshotAdvertised = false;

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
    unsubSnapshot?.();
    snapshotExchange?.destroy();
    coordinators.clear();
  }

  return { reconcile, destroy };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
