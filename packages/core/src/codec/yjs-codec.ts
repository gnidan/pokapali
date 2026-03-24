/**
 * YjsCrdtCodec — Yjs adapter for the CrdtCodec
 * interface.
 *
 * All operations work on raw Yjs update bytes
 * (Uint8Array) without instantiating Y.Doc for
 * merge, diff, or contains. A temporary Y.Doc is
 * only created for `apply` when needed.
 */
import * as Y from "yjs";
import type { CrdtCodec } from "./codec.js";

/**
 * Shared empty-doc update, computed once.
 */
const EMPTY_UPDATE: Uint8Array = (() => {
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
})();

export const yjsCrdtCodec: CrdtCodec = {
  merge(a: Uint8Array, b: Uint8Array): Uint8Array {
    return Y.mergeUpdates([a, b]);
  },

  diff(state: Uint8Array, base: Uint8Array): Uint8Array {
    // Apply base to a temporary doc to get its SV.
    // We cannot use encodeStateVectorFromUpdate —
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
};
