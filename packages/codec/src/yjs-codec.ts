/**
 * yjsCodec -- Yjs adapter for the Codec interface.
 *
 * All operations work on raw Yjs update bytes
 * (Uint8Array) without instantiating Y.Doc for
 * merge, diff, or contains. A temporary Y.Doc is
 * only created for `apply` when needed.
 */
import * as Y from "yjs";
import type { Codec, CodecSurface } from "./codec.js";

const REMOTE_ORIGIN = "remote";
const SNAPSHOT_ORIGIN = "snapshot";

/**
 * Shared empty-doc update, computed once.
 */
const EMPTY_UPDATE: Uint8Array = (() => {
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
})();

export const yjsCodec: Codec = {
  merge(a: Uint8Array, b: Uint8Array): Uint8Array {
    return Y.mergeUpdates([a, b]);
  },

  diff(state: Uint8Array, base: Uint8Array): Uint8Array {
    // Apply base to a temporary doc to get its SV.
    // We cannot use encodeStateVectorFromUpdate --
    // it's broken for delta updates (returns empty
    // SV when the update starts above clock 0).
    // See spike 0a FINDINGS.md.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base);
    const baseSV = Y.encodeStateVector(doc);
    doc.destroy();
    return Y.diffUpdate(state, baseSV);
  },

  apply(base: Uint8Array, update: Uint8Array): Uint8Array {
    // Apply both via a temporary doc to produce a
    // clean merged update.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base);
    Y.applyUpdate(doc, update);
    const result = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return result;
  },

  empty(): Uint8Array {
    return EMPTY_UPDATE;
  },

  contains(snapshot: Uint8Array, edit: Uint8Array): boolean {
    const snapMeta = Y.parseUpdateMeta(snapshot);
    const editMeta = Y.parseUpdateMeta(edit);

    for (const [clientId, editClock] of editMeta.to) {
      const snapClock = snapMeta.to.get(clientId) ?? 0;
      if (editClock > snapClock) {
        return false;
      }
    }
    return true;
  },

  createSurface(): CodecSurface {
    const doc = new Y.Doc();
    return {
      get handle() {
        return doc;
      },
      applyEdit(payload) {
        Y.applyUpdate(doc, payload, REMOTE_ORIGIN);
      },
      applyState(state) {
        Y.applyUpdate(doc, state, SNAPSHOT_ORIGIN);
      },
      onLocalEdit(cb) {
        const handler = (update: Uint8Array, origin: unknown) => {
          if (origin === REMOTE_ORIGIN) return;
          if (origin === SNAPSHOT_ORIGIN) return;
          cb(update);
        };
        doc.on("update", handler);
        return () => doc.off("update", handler);
      },
      destroy() {
        doc.destroy();
      },
    };
  },

  clockSum(state: Uint8Array): number {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const sv = Y.decodeStateVector(Y.encodeStateVector(doc));
    doc.destroy();
    let sum = 0;
    for (const clock of sv.values()) sum += clock;
    return sum;
  },
};
