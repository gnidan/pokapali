import type * as Y from "yjs";

/**
 * Origin marker for snapshot-applied updates.
 * Update handlers use this to distinguish remote
 * snapshot data from local edits.
 */
export const SNAPSHOT_ORIGIN: unique symbol = Symbol("snapshot-apply");

/**
 * Narrow interface for accessing Y.Docs by channel
 * name. Replaces the full SubdocManager dependency.
 */
export interface SubdocProvider {
  subdoc(ns: string): Y.Doc;
  readonly whenLoaded: Promise<void>;
}
