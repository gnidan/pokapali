/**
 * Subdocs — multi-channel Yjs subdocument manager.
 *
 * Manages a set of named Y.Doc instances for a single
 * pokapali document. Each channel maps to one Y.Doc,
 * plus a `_meta` doc for internal state (e.g. client
 * identity mappings).
 */
import * as Y from "yjs";

/**
 * Origin marker for snapshot-applied updates.
 * Update handlers use this to distinguish remote
 * snapshot data from local edits when computing
 * the dirty flag.
 */
const SNAPSHOT_ORIGIN: unique symbol = Symbol("snapshot-apply");

export interface Options {
  /** Reserved for future use. */
  primaryNamespace?: string;
  /**
   * Additional origins to suppress when computing
   * the dirty flag (e.g. y-indexeddb provider
   * instances). Checked via Set.has(origin).
   */
  skipOrigins?: Set<object>;
}

/**
 * Manages a set of named Yjs subdocuments for a
 * single pokapali document. Each channel maps to
 * one Y.Doc, plus a `_meta` doc for internal state.
 */
export interface Subdocs {
  /**
   * Returns the Y.Doc for the given namespace.
   * Throws if the namespace was not registered at
   * creation time and has not been introduced via
   * {@link Subdocs.applySnapshot}.
   */
  subdoc(ns: string): Y.Doc;
  /** The internal `_meta` subdocument. */
  readonly metaDoc: Y.Doc;
  /**
   * Encodes all subdocuments as Yjs state updates.
   * Resets the dirty flag after encoding.
   */
  encodeAll(): Record<string, Uint8Array>;
  /**
   * Applies a snapshot (namespace → Yjs update) to
   * the managed subdocuments. Creates new Y.Docs
   * on demand for namespaces not seen at creation.
   * Uses {@link Subdocs.SNAPSHOT_ORIGIN} so the
   * dirty flag is not set.
   */
  applySnapshot(data: Record<string, Uint8Array>): void;
  /**
   * True when any subdocument has received a local
   * update since the last {@link Subdocs.encodeAll}
   * call.
   */
  readonly isDirty: boolean;
  /**
   * Registers a listener for the "dirty" event,
   * fired on the first local update after the dirty
   * flag was cleared.
   */
  on(event: "dirty", cb: () => void): void;
  /** Removes a previously registered "dirty"
   *  listener. */
  off(event: "dirty", cb: () => void): void;
  /**
   * Resolves when all managed subdocuments have
   * finished loading.
   */
  readonly whenLoaded: Promise<void>;
  /**
   * Tears down update handlers and destroys all
   * managed Y.Docs. Idempotent.
   */
  destroy(): void;
}

export const Subdocs: {
  /**
   * Origin marker for snapshot-applied updates.
   */
  readonly SNAPSHOT_ORIGIN: typeof SNAPSHOT_ORIGIN;

  /**
   * Creates a Subdocs instance that owns one Y.Doc
   * per namespace plus a `_meta` doc. Each doc's
   * guid is `${ipnsName}:${namespace}`.
   */
  create(ipnsName: string, namespaces: string[], options?: Options): Subdocs;
} = {
  SNAPSHOT_ORIGIN,

  create(ipnsName: string, namespaces: string[], _options?: Options): Subdocs {
    const docs = new Map<string, Y.Doc>();
    let dirty = false;
    let destroyed = false;
    const dirtyListeners = new Set<() => void>();

    const allKeys = [...namespaces, "_meta"];
    for (const key of allKeys) {
      const guid = `${ipnsName}:${key}`;
      const doc = new Y.Doc({ guid, gc: true });
      docs.set(key, doc);
    }

    const updateHandlers = new Map<
      string,
      (update: Uint8Array, origin: unknown) => void
    >();

    const skipOrigins = _options?.skipOrigins;

    function makeUpdateHandler(): (
      _update: Uint8Array,
      origin: unknown,
    ) => void {
      return (_update, origin) => {
        if (origin === SNAPSHOT_ORIGIN) return;
        if (skipOrigins && skipOrigins.has(origin as object)) {
          return;
        }
        if (!dirty) {
          dirty = true;
          for (const cb of dirtyListeners) {
            cb();
          }
        }
      };
    }

    function registerDoc(key: string, doc: Y.Doc): void {
      const handler = makeUpdateHandler();
      updateHandlers.set(key, handler);
      doc.on("update", handler);
    }

    for (const [key, doc] of docs) {
      registerDoc(key, doc);
    }

    const loadPromises: Promise<void>[] = [];
    for (const doc of docs.values()) {
      loadPromises.push(doc.whenLoaded.then(() => {}));
      doc.load();
      doc.emit("load", [doc]);
    }
    const whenLoaded = Promise.all(loadPromises).then(() => {});

    return {
      subdoc(ns: string): Y.Doc {
        const doc = docs.get(ns);
        if (!doc) {
          throw new Error(`Unknown namespace: ${ns}`);
        }
        return doc;
      },

      get metaDoc(): Y.Doc {
        return docs.get("_meta")!;
      },

      encodeAll(): Record<string, Uint8Array> {
        const result: Record<string, Uint8Array> = {};
        for (const [key, doc] of docs) {
          result[key] = Y.encodeStateAsUpdate(doc);
        }
        dirty = false;
        return result;
      },

      applySnapshot(data: Record<string, Uint8Array>): void {
        for (const [key, update] of Object.entries(data)) {
          let doc = docs.get(key);
          if (!doc) {
            const guid = `${ipnsName}:${key}`;
            doc = new Y.Doc({ guid, gc: true });
            docs.set(key, doc);
            registerDoc(key, doc);
          }
          Y.applyUpdate(doc, update, SNAPSHOT_ORIGIN);
        }
      },

      get isDirty(): boolean {
        return dirty;
      },

      on(event: "dirty", cb: () => void): void {
        dirtyListeners.add(cb);
      },

      off(event: "dirty", cb: () => void): void {
        dirtyListeners.delete(cb);
      },

      get whenLoaded(): Promise<void> {
        return whenLoaded;
      },

      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        for (const [key, doc] of docs) {
          const handler = updateHandlers.get(key);
          if (handler) {
            doc.off("update", handler);
          }
          doc.destroy();
        }
        updateHandlers.clear();
        dirty = false;
        dirtyListeners.clear();
      },
    };
  },
};
