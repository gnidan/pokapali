/**
 * Edit bridge — wires CodecSurface `onEdit` callbacks
 * to Edit creation → channel.appendEdit → persistEdit
 * → scheduleReconcile.
 *
 * Extracted from create-doc.ts (S50 A2) as a pure
 * refactor.
 */

import { Edit, type Document } from "@pokapali/document";
import type { Codec, CodecSurface } from "@pokapali/codec";

/** Minimal subset of Document used by the bridge. */
export interface EditBridgeDocument {
  hasSurface(name: string): boolean;
  surface(name: string): CodecSurface;
  channel(name: string): ReturnType<Document["channel"]>;
}

export interface EditBridgeParams {
  /** Channel names declared by the codec. */
  channels: readonly string[];
  /** Document instance (may be absent in solo mode). */
  document: EditBridgeDocument | undefined;
  /** Codec for creating fallback surfaces. */
  codec: Codec;
  /** Hex-encoded identity public key (null when
   *  no identity is provided). */
  identityPubkeyHex: string | null;
  /** IPNS name — used as guid prefix for fallback
   *  surfaces. */
  ipnsName: string;
  /** Persist an edit to the Store. */
  persistEdit(channelName: string, edit: Edit): void;
  /** Schedule a reconciliation round. */
  scheduleReconcile(): void;
  /** Mark content as dirty (triggers save-state
   *  transitions). */
  markContentDirty(): void;
}

export interface EditBridge {
  /** Set of channel names already bridged (lazy). */
  surfaceBridged: Set<string>;
  /** Fallback surfaces for channels when no Document
   *  is provided (e.g. lazy/solo mode tests). */
  fallbackSurfaces: Map<string, CodecSurface>;
  /** Lazily register a reconciliation trigger on a
   *  CodecSurface. */
  ensureSurfaceBridged(name: string, surface: CodecSurface): void;
  /** Get or create a fallback surface for the given
   *  channel name. */
  getOrCreateFallback(name: string): CodecSurface;
  /** Push an additional cleanup callback. */
  pushCleanup(fn: () => void): void;
  /** Tear down all subscriptions and destroy fallback
   *  surfaces. */
  destroy(): void;
}

/**
 * Create the edit bridge that wires CodecSurface edits
 * into the epoch tree and reconciliation loop.
 */
export function createEditBridge(params: EditBridgeParams): EditBridge {
  const cleanups: Array<() => void> = [];
  const surfaceBridged = new Set<string>();
  const fallbackSurfaces = new Map<string, CodecSurface>();

  const {
    channels,
    document,
    identityPubkeyHex,
    persistEdit,
    scheduleReconcile,
    markContentDirty,
    codec,
    ipnsName,
  } = params;

  // Wire initial surfaces from the Document (if
  // present). Local edits are captured synchronously
  // so the epoch tree stays up-to-date for immediate
  // publish().
  if (document) {
    for (const name of channels) {
      if (!document.hasSurface(name)) continue;
      const surface = document.surface(name);
      const channel = document.channel(name);
      const unsub = surface.onEdit((update, isLocal) => {
        if (isLocal) {
          // Capture local user edits (from TipTap/
          // ProseMirror). Append synchronously so
          // the epoch tree is up-to-date for
          // immediate publish(). Signature is empty
          // — outgoing wire paths sign on-the-fly.
          const edit = Edit.create({
            payload: update,
            timestamp: Date.now(),
            author: identityPubkeyHex ?? "",
            channel: name,
            origin: "local",
            signature: new Uint8Array(),
          });
          channel.appendEdit(edit);
          persistEdit(name, edit);
          scheduleReconcile();
        }
        // Dirty tracking for all edits (local +
        // remote). Snapshot-origin updates are
        // excluded by onEdit itself.
        markContentDirty();
      });
      cleanups.push(unsub);
    }
  }

  function ensureSurfaceBridged(name: string, surface: CodecSurface): void {
    if (surfaceBridged.has(name)) return;
    surfaceBridged.add(name);
    const unsub = surface.onLocalEdit(() => {
      markContentDirty();
      scheduleReconcile();
    });
    cleanups.push(unsub);
  }

  function getOrCreateFallback(name: string): CodecSurface {
    let fb = fallbackSurfaces.get(name);
    if (!fb) {
      fb = codec.createSurface({
        guid: `${ipnsName}:${name}`,
      });
      // Wire dirty tracking on fallback
      const unsub = fb.onEdit(() => {
        markContentDirty();
      });
      cleanups.push(unsub);
      fallbackSurfaces.set(name, fb);
    }
    return fb;
  }

  function pushCleanup(fn: () => void): void {
    cleanups.push(fn);
  }

  function destroy(): void {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    for (const fb of fallbackSurfaces.values()) {
      fb.destroy();
    }
    fallbackSurfaces.clear();
  }

  return {
    surfaceBridged,
    fallbackSurfaces,
    ensureSurfaceBridged,
    getOrCreateFallback,
    pushCleanup,
    destroy,
  };
}
