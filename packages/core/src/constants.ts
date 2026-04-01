/**
 * Origin marker for snapshot-applied updates.
 * Update handlers use this to distinguish remote
 * snapshot data from local edits when computing
 * the dirty flag.
 */
export const SNAPSHOT_ORIGIN: unique symbol = Symbol("snapshot-apply");
