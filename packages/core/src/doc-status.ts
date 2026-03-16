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
  if (awarenessConnected) return "receiving";
  if (gossipActivity === "receiving") return "receiving";
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
            Date.now() + RETRY_BASE_MS * 3 ** (entry.fetchAttempt - 1),
        };
      }
      return {
        status: "failed",
        cid: entry.cid.toString(),
        error: entry.lastError ?? "unknown",
      };
    }
  }
  return { status: "idle" };
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
