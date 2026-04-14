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
import { verifyCid } from "./verify-cid.js";
import type { AsyncQueue } from "./async-utils.js";
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
    } catch {
      // CID parse failure — skip
      return;
    }

    // Inline block: decode, verify CID hash, then
    // store and emit facts. Verification is async
    // (WebCrypto sha256), so we handle the entire
    // fact-emission sequence in a .then() chain to
    // ensure unverified blocks never reach putBlock
    // or the interpreter.
    const emitFacts = (parsedCid: CID, block?: Uint8Array) => {
      factQueue.push({
        type: "cid-discovered",
        ts: Date.now(),
        cid: parsedCid,
        source: "gossipsub",
        block,
        seq: ann.seq,
      });

      // Ack/guarantee facts AFTER discovery so the
      // reducer's updateEntry finds the chain entry.
      if (ann.ack) {
        factQueue.push({
          type: "ack-received",
          ts: Date.now(),
          cid: parsedCid,
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
            cid: parsedCid,
            guaranteeUntil: ann.ack.guaranteeUntil ?? 0,
            retainUntil: ann.ack.retainUntil ?? 0,
          });
        }
      }
    };

    if (ann.block) {
      let decoded: Uint8Array;
      try {
        decoded = base64ToUint8(ann.block);
      } catch {
        // decode failure — emit without block
        emitFacts(cid);
        return;
      }
      verifyCid(cid, decoded).then((valid) => {
        if (valid) {
          putBlock(cid!, decoded);
          emitFacts(cid!, decoded);
        } else {
          // CID mismatch — emit without block
          emitFacts(cid!);
        }
      });
    } else {
      emitFacts(cid);
    }
  };
}
