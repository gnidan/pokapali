import * as Y from "yjs";

export const SNAPSHOT_ORIGIN: unique symbol = Symbol("snapshot-apply");
export const INDEXEDDB_ORIGIN: unique symbol = Symbol("indexeddb");

export interface SubdocManagerOptions {
  primaryNamespace?: string;
  /**
   * Additional origins to suppress when computing
   * the dirty flag (e.g. y-indexeddb provider
   * instances). Checked via Set.has(origin).
   */
  skipOrigins?: Set<object>;
}

export interface SubdocManager {
  subdoc(ns: string): Y.Doc;
  readonly metaDoc: Y.Doc;
  encodeAll(): Record<string, Uint8Array>;
  applySnapshot(data: Record<string, Uint8Array>): void;
  readonly isDirty: boolean;
  on(event: "dirty", cb: () => void): void;
  off(event: "dirty", cb: () => void): void;
  readonly whenLoaded: Promise<void>;
  destroy(): void;
}

export function createSubdocManager(
  ipnsName: string,
  namespaces: string[],
  _options?: SubdocManagerOptions,
): SubdocManager {
  const docs = new Map<string, Y.Doc>();
  let dirty = false;
  let destroyed = false;
  const dirtyListeners = new Set<() => void>();

  // Create docs for each namespace + _meta
  const allKeys = [...namespaces, "_meta"];
  for (const key of allKeys) {
    const guid = `${ipnsName}:${key}`;
    const doc = new Y.Doc({ guid, gc: true });
    docs.set(key, doc);
  }

  // Track updates for dirty flag
  const updateHandlers = new Map<
    string,
    (update: Uint8Array, origin: unknown) => void
  >();

  const skipOrigins = _options?.skipOrigins;

  for (const [key, doc] of docs) {
    const handler = (_update: Uint8Array, origin: unknown) => {
      if (origin === SNAPSHOT_ORIGIN || origin === INDEXEDDB_ORIGIN) {
        return;
      }
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
    updateHandlers.set(key, handler);
    doc.on("update", handler);
  }

  // Load all docs and build whenLoaded promise.
  // For root docs without a provider, load()
  // alone won't fire the 'load' event, so we
  // emit it manually after calling load().
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
        const doc = docs.get(key);
        if (doc) {
          Y.applyUpdate(doc, update, SNAPSHOT_ORIGIN);
        }
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
}
