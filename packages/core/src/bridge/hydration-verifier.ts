/**
 * HydrationVerifier — verifies that a hydrated
 * epoch tree (from snapshots) plus backfilled live
 * edits matches the live Y.Doc state.
 *
 * Steps per channel:
 * 1. Start with snapshot epochs (if any)
 * 2. Merge snapshot payloads into a base state
 * 3. Find live edits not covered by snapshots
 *    (via codec.contains)
 * 4. Merge base + backfilled edits
 * 5. Compare against live Y.Doc (same
 *    normalization as ParallelVerifier)
 */

import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import type { SubdocManager } from "@pokapali/subdocs";
import type { CrdtCodec } from "../codec/codec.js";
import type { Document } from "../document/document.js";
import type { Epoch } from "../epoch/types.js";

export interface HydrationVerifyResult {
  match: boolean;
  channel: string;
  snapshotEpochCount: number;
  backfilledEditCount: number;
  details?: string;
}

export interface HydrationVerifyOptions {
  document: Document;
  subdocManager: SubdocManager;
  channelNames: string[];
  codec: CrdtCodec;
  /** Hydrated epochs from hydrateFromSnapshots,
   *  or null if no snapshots available. */
  snapshotEpochs: Map<string, Epoch[]> | null;
}

function verifyChannel(
  channelName: string,
  opts: HydrationVerifyOptions,
): HydrationVerifyResult {
  const { document, subdocManager, codec, snapshotEpochs } = opts;

  const ch = document.channel(channelName);

  // Step 1: Build base state from snapshot epochs
  const snapEpochs = snapshotEpochs?.get(channelName) ?? [];
  const snapshotEpochCount = snapEpochs.length;

  let baseState = codec.empty();
  for (const ep of snapEpochs) {
    for (const e of ep.edits) {
      baseState = codec.merge(baseState, e.payload);
    }
  }

  // Step 2: Find live edits not covered by
  // snapshot base state, and backfill
  const liveEpochs = toArray(ch.tree);
  let backfilledEditCount = 0;

  for (const ep of liveEpochs) {
    for (const e of ep.edits) {
      if (!codec.contains(baseState, e.payload)) {
        baseState = codec.merge(baseState, e.payload);
        backfilledEditCount++;
      }
    }
  }

  // Step 3: Compare against live Y.Doc
  const subdoc = subdocManager.subdoc(channelName);
  const liveState = Y.encodeStateAsUpdate(subdoc);

  const normalizedHydrated = codec.merge(baseState, codec.empty());
  const normalizedLive = codec.merge(liveState, codec.empty());

  const hydratedDiffLive = codec.diff(normalizedHydrated, normalizedLive);
  const liveDiffHydrated = codec.diff(normalizedLive, normalizedHydrated);

  const hydratedHasExtra = hydratedDiffLive.length > 2;
  const liveHasExtra = liveDiffHydrated.length > 2;

  if (hydratedHasExtra || liveHasExtra) {
    const parts: string[] = [];
    if (hydratedHasExtra) {
      parts.push(
        `hydrated has ` + `${hydratedDiffLive.length}b ` + "not in live",
      );
    }
    if (liveHasExtra) {
      parts.push(
        `live has ` + `${liveDiffHydrated.length}b ` + "not in hydrated",
      );
    }
    return {
      match: false,
      channel: channelName,
      snapshotEpochCount,
      backfilledEditCount,
      details: parts.join("; "),
    };
  }

  return {
    match: true,
    channel: channelName,
    snapshotEpochCount,
    backfilledEditCount,
  };
}

/**
 * Verify that hydrated snapshots + backfilled
 * live edits produce the same state as the live
 * Y.Doc, for each channel.
 */
export async function verifyHydration(
  opts: HydrationVerifyOptions,
): Promise<HydrationVerifyResult[]> {
  return opts.channelNames.map((name) => verifyChannel(name, opts));
}
