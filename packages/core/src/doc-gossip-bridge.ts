/**
 * doc-gossip-bridge.ts — Converts GossipSub pubsub
 * messages into interpreter facts.
 *
 * Extracted from create-doc.ts for composability.
 * Pure factory function — no ambient state.
 */

import { CID } from "multiformats/cid";
import {
  parseAnnouncement,
  parseGuaranteeResponse,
  base64ToUint8,
} from "./announce.js";
import type { AsyncQueue } from "./sources.js";
import type { Fact } from "./facts.js";

export interface GossipBridgeDeps {
  topic: string;
  ipnsName: string;
  factQueue: AsyncQueue<Fact>;
  /** Store inline blocks for later retrieval. */
  putBlock: (cid: CID, block: Uint8Array) => void;
}

/**
 * Creates an event handler that converts GossipSub
 * "message" events into interpreter facts.
 *
 * Attach to pubsub via:
 *   pubsub.addEventListener("message", handler)
 */
export function createGossipHandler(
  deps: GossipBridgeDeps,
): (evt: CustomEvent) => void {
  const { topic, ipnsName, factQueue, putBlock } = deps;

  return (evt: CustomEvent) => {
    const { detail } = evt;
    if (detail?.topic !== topic) return;

    // Liveness fact for every message
    factQueue.push({
      type: "gossip-message",
      ts: Date.now(),
    });

    // Check guarantee response first
    const gResp = parseGuaranteeResponse(detail.data);
    if (gResp && gResp.ipnsName === ipnsName) {
      try {
        factQueue.push({
          type: "guarantee-received",
          ts: Date.now(),
          peerId: gResp.peerId,
          cid: CID.parse(gResp.cid),
          guaranteeUntil: gResp.guaranteeUntil ?? 0,
          retainUntil: gResp.retainUntil ?? 0,
        });
      } catch {
        // CID parse failure — skip
      }
      return;
    }

    const ann = parseAnnouncement(detail.data);
    if (!ann || ann.ipnsName !== ipnsName) return;

    // CID discovery FIRST — the chain entry must
    // exist before ack/guarantee facts reference it.
    let cid: CID | undefined;
    try {
      cid = CID.parse(ann.cid);
      let block: Uint8Array | undefined;
      if (ann.block) {
        try {
          block = base64ToUint8(ann.block);
          putBlock(cid, block);
        } catch {
          // decode failure — skip inline block
        }
      }
      factQueue.push({
        type: "cid-discovered",
        ts: Date.now(),
        cid,
        source: "gossipsub",
        block,
        seq: ann.seq,
      });
    } catch {
      // CID parse failure — skip
    }

    // Ack/guarantee facts AFTER discovery so the
    // reducer's updateEntry finds the chain entry.
    if (ann.ack && cid) {
      factQueue.push({
        type: "ack-received",
        ts: Date.now(),
        cid,
        peerId: ann.ack.peerId,
      });
      if (
        ann.ack.guaranteeUntil !== undefined ||
        ann.ack.retainUntil !== undefined
      ) {
        factQueue.push({
          type: "guarantee-received",
          ts: Date.now(),
          peerId: ann.ack.peerId,
          cid,
          guaranteeUntil: ann.ack.guaranteeUntil ?? 0,
          retainUntil: ann.ack.retainUntil ?? 0,
        });
      }
    }
  };
}
