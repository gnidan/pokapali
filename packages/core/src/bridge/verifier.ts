/**
 * ParallelVerifier — evaluates mergedPayload on a
 * channel's epoch tree, compares against the live
 * Y.Doc state via codec.diff to confirm consistency.
 *
 * Also computes contentHash per channel for
 * diagnostic logging.
 *
 * Passive — caller drives, no event hooks.
 */
import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import type { SubdocManager } from "@pokapali/subdocs";
import type { CrdtCodec } from "../codec/codec.js";
import type { Document } from "../document/document.js";
import { mergedPayloadView } from "../view/merged-payload.js";
import { contentHashView } from "../view/content-hash.js";

export interface VerifyResult {
  match: boolean;
  channel: string;
  epochCount: number;
  contentHash?: Uint8Array;
  details?: string;
}

export interface ParallelVerifier {
  verify(channelName: string): VerifyResult;
  verifyAll(): VerifyResult[];
}

export function createParallelVerifier(opts: {
  document: Document;
  subdocManager: SubdocManager;
  channelNames: string[];
  codec: CrdtCodec;
}): ParallelVerifier {
  const { document, subdocManager, channelNames, codec } = opts;

  function verify(channelName: string): VerifyResult {
    const ch = document.channel(channelName);
    const epochs = toArray(ch.tree);
    const epochCount = epochs.length;

    // Compute merged payload from epoch tree
    const mergeView = mergedPayloadView(codec);
    const feed = ch.activate(mergeView);
    const mergeState = feed.getSnapshot();
    ch.deactivate(mergeView.name);

    // Compute content hash for diagnostics
    const hashView = contentHashView();
    const hashFeed = ch.activate(hashView);
    const hashState = hashFeed.getSnapshot();
    ch.deactivate(hashView.name);

    const contentHash = hashState.tag === "ready" ? hashState.value : undefined;

    if (mergeState.tag !== "ready") {
      return {
        match: false,
        channel: channelName,
        epochCount,
        contentHash,
        details: `view not ready: ${mergeState.tag}`,
      };
    }

    const treeMerged = mergeState.value;

    // Get live Y.Doc state
    const subdoc = subdocManager.subdoc(channelName);
    const liveState = Y.encodeStateAsUpdate(subdoc);

    // Normalize both sides through codec.merge
    // with empty to ensure canonical form
    const normalizedTree = codec.merge(treeMerged, codec.empty());
    const normalizedLive = codec.merge(liveState, codec.empty());

    // Compare: diff in both directions should be
    // empty
    const treeDiffLive = codec.diff(normalizedTree, normalizedLive);
    const liveDiffTree = codec.diff(normalizedLive, normalizedTree);

    const treeHasExtra = treeDiffLive.length > 2;
    const liveHasExtra = liveDiffTree.length > 2;

    if (treeHasExtra || liveHasExtra) {
      const parts: string[] = [];
      if (treeHasExtra) {
        parts.push(`tree has ${treeDiffLive.length}b ` + "not in live");
      }
      if (liveHasExtra) {
        parts.push(`live has ${liveDiffTree.length}b ` + "not in tree");
      }
      return {
        match: false,
        channel: channelName,
        epochCount,
        contentHash,
        details: parts.join("; "),
      };
    }

    return {
      match: true,
      channel: channelName,
      epochCount,
      contentHash,
    };
  }

  return {
    verify,
    verifyAll() {
      return channelNames.map(verify);
    },
  };
}
