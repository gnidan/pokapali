/**
 * doc-status.ts — Pure derivation functions for
 * DocStatus, SaveState, and LoadingState.
 *
 * No side effects, no closure state. Used by
 * create-doc.ts and available for testing.
 */

import type {
  DocState,
  DocStatus,
  SaveState,
  LoadingState,
  SyncStatus,
  GossipActivity,
} from "./facts.js";
import { MAX_INTERPRETER_RETRIES, RETRY_BASE_MS } from "./interpreter.js";

/** Grace period (ms) during which "offline" is
 *  reported as "connecting" to avoid a false
 *  "offline" flash while the mesh forms. */
export const MESH_GRACE_MS = 5_000;

export function computeStatus(
  syncStatus: SyncStatus,
  awarenessConnected: boolean,
  gossipActivity: GossipActivity,
  createdAt?: number,
): DocStatus {
  if (syncStatus === "connected") return "synced";
  if (syncStatus === "connecting") return "connecting";
  if (gossipActivity === "receiving") return "receiving";
  // Awareness-only = cursors visible but edits may
  // not sync (#224). Report "connecting" not
  // "receiving" so consumers don't show a false
  // "collaborating" state.
  if (awarenessConnected) return "connecting";
  if (gossipActivity === "subscribed") {
    return "connecting";
  }
  // During startup, mesh peers haven't connected
  // yet. Show "connecting" instead of "offline"
  // for a brief grace period.
  if (createdAt !== undefined && Date.now() - createdAt < MESH_GRACE_MS) {
    return "connecting";
  }
  return "offline";
}

export function computeSaveState(
  isDirty: boolean,
  isSaving: boolean,
  lastSaveError?: string | null,
): SaveState {
  if (isSaving) return "saving";
  if (lastSaveError) return "save-error";
  if (isDirty) return "dirty";
  return "saved";
}

// ── Loading state derivation from DocState ──────

export function deriveLoadingState(state: DocState): LoadingState {
  if (state.ipnsStatus.phase === "resolving") {
    return {
      status: "resolving",
      startedAt: state.ipnsStatus.startedAt,
    };
  }
  for (const entry of state.chain.entries.values()) {
    if (entry.blockStatus === "fetching" && entry.fetchStartedAt) {
      return {
        status: "fetching",
        cid: entry.cid.toString(),
        startedAt: entry.fetchStartedAt,
      };
    }
  }
  for (const entry of state.chain.entries.values()) {
    if (entry.blockStatus === "failed") {
      if (entry.fetchAttempt < MAX_INTERPRETER_RETRIES) {
        return {
          status: "retrying",
          cid: entry.cid.toString(),
          attempt: entry.fetchAttempt,
          nextRetryAt:
            Date.now() + RETRY_BASE_MS * 4 ** (entry.fetchAttempt - 1),
        };
      }
      return {
        status: "failed",
        cid: entry.cid.toString(),
        error: entry.lastError ?? "unknown",
      };
    }
  }
  // IPNS resolved with a CID but fetch hasn't
  // started yet — still "resolving" to prevent
  // premature markReady.
  if (state.ipnsStatus.phase === "resolved" && state.chain.entries.size > 0) {
    for (const entry of state.chain.entries.values()) {
      if (entry.blockStatus === "unknown") {
        return {
          status: "resolving",
          startedAt: state.ipnsStatus.at,
        };
      }
    }
  }
  return { status: "idle" };
}

// ── Human-readable labels ───────────────────────

/** Human-readable label for DocStatus. */
export function statusLabel(status: DocStatus): string {
  switch (status) {
    case "synced":
      return "Live";
    case "receiving":
      return "Subscribed";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
  }
}

/** Human-readable label for SaveState. */
export function saveLabel(state: SaveState): string {
  switch (state) {
    case "saved":
      return "Published";
    case "unpublished":
      return "Publish now";
    case "saving":
      return "Saving\u2026";
    case "dirty":
      return "Publish changes";
    case "save-error":
      return "Save failed";
  }
}

export function loadingStateChanged(a: LoadingState, b: LoadingState): boolean {
  if (a.status !== b.status) return true;
  if ("cid" in a && "cid" in b && a.cid !== b.cid) {
    return true;
  }
  if (
    a.status === "retrying" &&
    b.status === "retrying" &&
    a.attempt !== b.attempt
  ) {
    return true;
  }
  return false;
}
