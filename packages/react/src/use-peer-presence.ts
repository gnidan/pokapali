import { useState, useEffect, useRef } from "react";
import type { Doc, DocStatus } from "@pokapali/core";
import { useFeed } from "./use-feed.js";
import { useParticipants } from "./use-participants.js";

export type PeerPresenceState =
  | "connecting"
  | "looking"
  | "active"
  | "reconnecting";

export interface PeerPresenceResult {
  /** Current presence state. */
  state: PeerPresenceState;
  /** Number of other users (excludes self). */
  peerCount: number;
  /** Human-readable label for the current state. */
  label: string;
}

/** Maximum delay (ms) before "Looking for peers"
 *  settles into "Just you" when signaling hasn't
 *  connected yet. */
const MAX_SETTLE_MS = 10_000;
/** Short delay (ms) once signaling is established
 *  (status "synced") with no peers. Awareness has
 *  already exchanged state at this point, so a
 *  brief pause suffices. */
const SYNCED_SETTLE_MS = 2_000;

function isConnected(status: DocStatus): boolean {
  return status === "synced" || status === "receiving";
}

function deriveLabel(state: PeerPresenceState, peerCount: number): string {
  switch (state) {
    case "connecting":
      return "Connecting\u2026";
    case "looking":
      return "Looking for peers\u2026";
    case "reconnecting":
      return "Reconnecting\u2026";
    case "active":
      if (peerCount === 0) return "Just you";
      if (peerCount === 1) return "1 user editing";
      return `${peerCount} users editing`;
  }
}

/**
 * Derive a 4-state peer presence indicator from
 * existing doc feeds.
 *
 * Composes `doc.status` (connectivity) with
 * `doc.participants` (awareness) to produce a
 * human-readable presence state without requiring
 * new core API surface.
 *
 * States:
 * - **connecting** — initial connection in progress
 * - **looking** — connected but no peers yet
 * - **active** — peers present, or settled to
 *   "Just you" after {@link SETTLE_MS}
 * - **reconnecting** — connection dropped after
 *   having been connected
 */
export function usePeerPresenceState(doc: Doc): PeerPresenceResult {
  const status = useFeed(doc.status);
  const participants = useParticipants(doc);
  const wasConnected = useRef(false);
  const [settled, setSettled] = useState(false);

  // Reset state when doc identity changes
  useEffect(() => {
    wasConnected.current = false;
    setSettled(false);
  }, [doc]);

  // Count peers excluding self
  const myClientId = doc.awareness.clientID;
  let peerCount = 0;
  for (const [id] of participants) {
    if (id !== myClientId) peerCount++;
  }

  // Track whether we've ever been connected
  if (isConnected(status)) {
    wasConnected.current = true;
  }

  // Settling timer: wait for awareness/signaling
  // to establish before showing "Just you".
  // "synced" means WebRTC (and awareness) is
  // connected — settle quickly. Otherwise use
  // a longer window for signaling to establish.
  useEffect(() => {
    if (!isConnected(status) || peerCount > 0) {
      setSettled(false);
      return;
    }

    const delay = status === "synced" ? SYNCED_SETTLE_MS : MAX_SETTLE_MS;
    const timer = setTimeout(() => {
      setSettled(true);
    }, delay);
    return () => clearTimeout(timer);
  }, [status, peerCount]);

  // Derive state
  let state: PeerPresenceState;

  if (!isConnected(status)) {
    state = wasConnected.current ? "reconnecting" : "connecting";
  } else if (peerCount > 0) {
    state = "active";
  } else if (settled) {
    state = "active";
  } else {
    state = "looking";
  }

  return {
    state,
    peerCount,
    label: deriveLabel(state, peerCount),
  };
}
