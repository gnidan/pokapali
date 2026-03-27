/**
 * state-selectors.ts — Pure selectors for projecting
 * derived values from DocState.
 *
 * Used with projectFeed to replace WritableFeed-based
 * status and saveState feeds.
 */
import type { DocState, DocStatus, SaveState } from "./facts.js";

export function selectStatus(s: DocState): DocStatus {
  return s.status;
}

export function selectSaveState(s: DocState): SaveState {
  return s.saveState;
}
