/**
 * ParallelVerifier -- evaluates mergedPayload on a
 * channel's epoch tree, compares against the live
 * Y.Doc state via codec.diff to confirm consistency.
 *
 * Also computes contentHash per channel for
 * diagnostic logging.
 *
 * Passive -- caller drives, no event hooks.
 */
import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import type { SubdocManager } from "@pokapali/subdocs";
import type { Codec } from "@pokapali/codec";
import { type Document, State, Fingerprint } from "@pokapali/document";

export interface ParallelVerifyResult {
  match: boolean;
  channel: string;
  epochCount: number;
  contentHash?: Uint8Array;
  details?: string;
}

export interface ParallelVerifier {
  verify(channelName: string): ParallelVerifyResult;
  verifyAll(): ParallelVerifyResult[];
}

export const ParallelVerifier: {
  create(opts: {
    document: Document;
    subdocManager: SubdocManager;
    channelNames: string[];
    codec: Codec;
  }): ParallelVerifier;
} = {
  create(opts) {
    const { document, subdocManager, channelNames, codec } = opts;

    function verify(channelName: string): ParallelVerifyResult {
      const ch = document.channel(channelName);
      const epochs = toArray(ch.tree);
      const epochCount = epochs.length;

      const mergeView = State.view(codec);
      const feed = ch.activate(mergeView);
      const mergeState = feed.getSnapshot();
      ch.deactivate(mergeView.name);

      const hashView = Fingerprint.view();
      const hashFeed = ch.activate(hashView);
      const hashState = hashFeed.getSnapshot();
      ch.deactivate(hashView.name);

      const contentHash =
        hashState.tag === "ready" ? hashState.value : undefined;

      if (mergeState.tag !== "ready") {
        return {
          match: false,
          channel: channelName,
          epochCount,
          contentHash,
          details: `view not ready: ` + `${mergeState.tag}`,
        };
      }

      const treeMerged = mergeState.value;

      const subdoc = subdocManager.subdoc(channelName);
      const liveState = Y.encodeStateAsUpdate(subdoc);

      const normalizedTree = codec.merge(treeMerged, codec.empty());
      const normalizedLive = codec.merge(liveState, codec.empty());

      const treeDiffLive = codec.diff(normalizedTree, normalizedLive);
      const liveDiffTree = codec.diff(normalizedLive, normalizedTree);

      const treeHasExtra = treeDiffLive.length > 2;
      const liveHasExtra = liveDiffTree.length > 2;

      if (treeHasExtra || liveHasExtra) {
        const parts: string[] = [];
        if (treeHasExtra) {
          parts.push(`tree has ` + `${treeDiffLive.length}b ` + "not in live");
        }
        if (liveHasExtra) {
          parts.push(`live has ` + `${liveDiffTree.length}b ` + "not in tree");
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
  },
};
