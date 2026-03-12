/**
 * shadow-compare.ts — Comparison utility for shadow
 * mode validation between the old system
 * (snapshot-watcher + create-doc) and the new system
 * (interpreter DocState).
 *
 * Used during the migration period to verify the
 * interpreter produces equivalent state.
 *
 * Compared fields (exact match):
 *   status, saveState, gossipActivity, tipCid,
 *   ackedBy, guaranteeUntil, retainUntil
 *
 * Intentionally skipped (per architect):
 *   fetchAttempt counts, timestamps
 *   (lastMessageAt, fetchStartedAt),
 *   pendingQueries, announce state, ipnsStatus
 *
 * NOTE: Core should debounce calls to
 * compareShadowState by ~500ms to avoid reporting
 * transient mismatches that resolve within a tick.
 */

import type { DocStatus, SaveState, GossipActivity } from "./facts.js";

// ------------------------------------------------
// State interfaces
// ------------------------------------------------

/**
 * Projected state from the old system
 * (snapshot-watcher + create-doc).
 *
 * guaranteeUntil/retainUntil are aggregates
 * (max across all pinners), matching
 * bestGuarantee() from facts.ts.
 */
export interface OldSystemState {
  status: DocStatus;
  saveState: SaveState;
  ackedBy: ReadonlySet<string>;
  guaranteeUntil: number;
  retainUntil: number;
  gossipActivity: GossipActivity;
  tipCid: string | null;
}

/**
 * Projected state from the new system
 * (interpreter DocState).
 *
 * guaranteeUntil/retainUntil come from
 * bestGuarantee(docState.chain).
 */
export interface NewSystemState {
  status: DocStatus;
  saveState: SaveState;
  ackedBy: ReadonlySet<string>;
  guaranteeUntil: number;
  retainUntil: number;
  gossipActivity: GossipActivity;
  tipCid: string | null;
}

// ------------------------------------------------
// Discrepancy
// ------------------------------------------------

export interface Discrepancy {
  field: string;
  old: unknown;
  new: unknown;
}

// ------------------------------------------------
// Set equality
// ------------------------------------------------

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

// ------------------------------------------------
// Compare
// ------------------------------------------------

export function compareShadowState(
  old: OldSystemState,
  nw: NewSystemState,
): Discrepancy[] {
  const result: Discrepancy[] = [];

  if (old.status !== nw.status) {
    result.push({
      field: "status",
      old: old.status,
      new: nw.status,
    });
  }

  if (old.saveState !== nw.saveState) {
    result.push({
      field: "saveState",
      old: old.saveState,
      new: nw.saveState,
    });
  }

  if (old.gossipActivity !== nw.gossipActivity) {
    result.push({
      field: "gossipActivity",
      old: old.gossipActivity,
      new: nw.gossipActivity,
    });
  }

  if (old.tipCid !== nw.tipCid) {
    result.push({
      field: "tipCid",
      old: old.tipCid,
      new: nw.tipCid,
    });
  }

  if (!setsEqual(old.ackedBy, nw.ackedBy)) {
    result.push({
      field: "ackedBy",
      old: [...old.ackedBy].sort(),
      new: [...nw.ackedBy].sort(),
    });
  }

  if (old.guaranteeUntil !== nw.guaranteeUntil) {
    result.push({
      field: "guaranteeUntil",
      old: old.guaranteeUntil,
      new: nw.guaranteeUntil,
    });
  }

  if (old.retainUntil !== nw.retainUntil) {
    result.push({
      field: "retainUntil",
      old: old.retainUntil,
      new: nw.retainUntil,
    });
  }

  return result;
}
