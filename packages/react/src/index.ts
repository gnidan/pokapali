export { useFeed } from "./use-feed.js";
export { useDocReady } from "./use-doc-ready.js";
export { useAutoSave } from "./use-auto-save.js";
export { useDocDestroy } from "./use-doc-destroy.js";
export { useParticipants } from "./use-participants.js";
export { useSnapshotFlash } from "./use-snapshot-flash.js";

export { useComments } from "./use-comments.js";
export type { CommentData, UseCommentsOptions } from "./use-comments.js";

export { CommentSidebar } from "./comment-sidebar.js";
export type { CommentSidebarProps } from "./comment-sidebar.js";

export { CommentPopover } from "./comment-popover.js";
export type { CommentPopoverProps } from "./comment-popover.js";

export { useSaveLabel } from "./use-save-label.js";
export type { SaveLabelResult } from "./use-save-label.js";

export { useLastUpdated } from "./use-last-updated.js";
export type { LastUpdatedResult } from "./use-last-updated.js";

export { useStatusLabel } from "./use-status-label.js";
export type { StatusLabelResult } from "./use-status-label.js";

/** @deprecated Use {@link useSaveLabel} hook instead. */
export { SaveIndicator } from "./save-indicator.js";
/** @deprecated Use {@link useLastUpdated} hook instead. */
export { LastUpdated } from "./save-indicator.js";
export type {
  SaveIndicatorProps,
  LastUpdatedProps,
  SaveIndicatorLabels,
} from "./save-indicator.js";
export { defaultSaveIndicatorLabels } from "./save-indicator.js";

/** @deprecated Use {@link useStatusLabel} hook instead. */
export { StatusIndicator } from "./status-indicator.js";
export type {
  StatusIndicatorProps,
  StatusIndicatorLabels,
} from "./status-indicator.js";
export { defaultStatusIndicatorLabels } from "./status-indicator.js";

export { spatialLayout } from "./spatial-layout.js";
export type { LayoutItem, PositionedItem } from "./spatial-layout.js";

export {
  defaultSidebarLabels,
  defaultPopoverLabels,
  resolveSidebarLabels,
  resolvePopoverLabels,
} from "./comment-labels.js";
export type {
  CommentSidebarLabels,
  CommentPopoverLabels,
} from "./comment-labels.js";
