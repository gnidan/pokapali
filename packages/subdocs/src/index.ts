import * as Y from "yjs";

export const SNAPSHOT_ORIGIN: unique symbol =
  Symbol("snapshot-apply");
export const INDEXEDDB_ORIGIN: unique symbol =
  Symbol("indexeddb");

export interface SubdocManagerOptions {
  primaryNamespace?: string;
}

export interface SubdocManager {
  subdoc(ns: string): Y.Doc;
  readonly metaDoc: Y.Doc;
  encodeAll(): Record<string, Uint8Array>;
  applySnapshot(
    data: Record<string, Uint8Array>
  ): void;
  readonly isDirty: boolean;
  on(event: "dirty", cb: () => void): void;
  off(event: "dirty", cb: () => void): void;
  readonly whenLoaded: Promise<void>;
  destroy(): void;
}

export function createSubdocManager(
  ipnsName: string,
  namespaces: string[],
  options?: SubdocManagerOptions
): SubdocManager {
  throw new Error("not implemented");
}
