/**
 * Re-exports for backwards compatibility.
 *
 * New code should import from edit.ts and epoch.ts
 * directly.
 */
import type { CID } from "multiformats/cid";
import { Edit } from "./edit.js";
import { Boundary, Epoch } from "./epoch.js";

export type { Edit, Origin, EditOrigin } from "./edit.js";
export type { Boundary, EpochBoundary, Epoch } from "./epoch.js";

/** @deprecated Use `Edit.create` instead. */
export const edit = Edit.create;

/** @deprecated Use `Boundary.open` instead. */
export const openBoundary = Boundary.open;

/** @deprecated Use `Boundary.closed` instead. */
export const closedBoundary = Boundary.closed;

/** @deprecated Use `Boundary.snapshotted` instead. */
export const snapshottedBoundary = Boundary.snapshotted;

/** @deprecated Use `Epoch.create` instead. */
export const epoch = Epoch.create;

/** @deprecated Use `Epoch.append` instead. */
export const appendEdit = Epoch.append;

/** @deprecated Use `Epoch.isOpen` instead. */
export const isOpen = Epoch.isOpen;

/** @deprecated Use `Epoch.close` instead. */
export const closeEpoch = Epoch.close;

/** @deprecated Use `Epoch.snapshot` instead. */
export function snapshotEpoch(
  ep: import("./epoch.js").Epoch,
  cid: CID,
): import("./epoch.js").Epoch {
  return Epoch.snapshot(ep, cid);
}
