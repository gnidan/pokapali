/**
 * Re-export history types from @pokapali/document
 * for backwards compatibility.
 */
export type { Edit, EditOrigin, Epoch } from "@pokapali/document";
export {
  edit,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
  epoch,
  appendEdit,
  isOpen,
  closeEpoch,
  snapshotEpoch,
} from "@pokapali/document";

export type { Boundary as EpochBoundary } from "@pokapali/document";
