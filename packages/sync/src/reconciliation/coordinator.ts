/**
 * Per-channel-per-peer reconciliation coordinator.
 *
 * Drives bidirectional reconciliation by managing two
 * session state machines: one where we initiated
 * (outSession — peer queries our trie) and one where
 * the peer initiated (inSession — we query their trie).
 *
 * @module
 */

import { sha256 } from "@noble/hashes/sha256";
import type { Channel, Edit } from "@pokapali/document";
import { Edit as EditCompanion } from "@pokapali/document";
import { createSession } from "./session.js";
import {
  collectEditHashes,
  buildEditIndex,
  channelFingerprint,
} from "./edit-resolver.js";
import { type Message, MessageType } from "./messages.js";

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export interface MessageSender {
  send(msg: Message): void;
}

export interface EditApplier {
  apply(edit: Edit): void;
  applySnapshot?(snapshot: Uint8Array): void;
}

export interface CoordinatorOptions {
  channel: Channel;
  channelName: string;
  sender: MessageSender;
  applier: EditApplier;
  trustedKeys?: Set<string>;
  /** Async signature verification. Called for each
   *  signed edit when trustedKeys is set. Must return
   *  the verified payload or null to reject. */
  verifySig?: (sig: Uint8Array) => Promise<Uint8Array | null>;
  localSnapshot?: Uint8Array;
}

export interface ReconciliationCoordinator {
  start(): void;
  receive(msg: Message): void;
  readonly done: boolean;
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function hexHash(h: Uint8Array): string {
  return Array.from(h)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type WireEdit = {
  payload: Uint8Array;
  signature: Uint8Array;
};

// -------------------------------------------------------
// Implementation
// -------------------------------------------------------

export function createCoordinator(
  options: CoordinatorOptions,
): ReconciliationCoordinator {
  const {
    channel,
    channelName,
    sender,
    applier,
    trustedKeys,
    verifySig,
    localSnapshot,
  } = options;

  // Two sessions: out (we initiated) and in (peer
  // initiated). Messages route by type.
  type Session = ReturnType<typeof createSession>;
  let outSession: Session | null = null;
  let inSession: Session | null = null;

  let inDone = false;
  // Once a FULL_STATE snapshot is applied, skip all
  // further edit application. Both session directions
  // may independently try to deliver data — the
  // snapshot already contains the peer's full state,
  // so individual edits from the other direction are
  // redundant and would cause double-application.
  let snapshotApplied = false;

  function start(): void {
    const hashes = collectEditHashes(channel);
    const fp = channelFingerprint(channel);
    outSession = createSession(hashes, fp, channelName, localSnapshot);
    const msg = outSession.initiate();
    sender.send(msg);
  }

  function receive(msg: Message): void {
    switch (msg.type) {
      // Peer initiated — create inSession
      case MessageType.RECONCILE_START:
        handleIncoming(msg);
        break;

      // Peer querying our trie → outSession
      case MessageType.TRIE_QUERY:
      case MessageType.EDIT_SET:
        handleOutgoing(msg);
        break;

      // Responses to our queries → inSession
      case MessageType.TRIE_RESPONSE:
        handleIncoming(msg);
        break;

      // Peer's edits for us → inSession
      case MessageType.EDIT_BATCH:
        handleIncoming(msg);
        break;

      // Peer's full state → inSession
      case MessageType.FULL_STATE:
        handleIncoming(msg);
        break;
    }
  }

  function handleOutgoing(msg: Message): void {
    if (!outSession) return;
    const result = outSession.receive(msg);
    processResult(result, "out");
  }

  function handleIncoming(msg: Message): void {
    if (msg.type === MessageType.RECONCILE_START && !inSession) {
      const hashes = collectEditHashes(channel);
      const fp = channelFingerprint(channel);
      inSession = createSession(hashes, fp, channelName, localSnapshot);
    }

    if (!inSession) return;
    const result = inSession.receive(msg);
    processResult(result, "in");
  }

  function processResult(
    result: Message | WireEdit[] | null,
    direction: "in" | "out",
  ): void {
    if (result === null) {
      // Session complete (in sync or done)
      if (direction === "in") inDone = true;
      return;
    }

    if (Array.isArray(result)) {
      // Received edits — verify and apply
      verifyAndApply(result);
      if (direction === "in") inDone = true;
      return;
    }

    // Outgoing message — resolve if EDIT_BATCH
    if (result.type === MessageType.EDIT_BATCH) {
      resolveAndSend(result);
    } else {
      sender.send(result);
    }
  }

  function resolveAndSend(
    msg: Extract<Message, { type: typeof MessageType.EDIT_BATCH }>,
  ): void {
    // Session puts hashes as payloads in EDIT_BATCH.
    // Resolve hash → real Edit from channel index.
    const index = buildEditIndex(channel);
    const resolved = msg.edits.map((e) => {
      const hex = hexHash(e.payload);
      const real = index.get(hex);
      if (!real) return e;
      return {
        payload: real.payload,
        signature: real.signature,
      };
    });

    sender.send({
      type: MessageType.EDIT_BATCH,
      channel: msg.channel,
      edits: resolved,
    });
  }

  function verifyAndApply(edits: WireEdit[]): void {
    // If a snapshot was already applied, the peer's
    // full state is already present — skip redundant
    // individual edits from the other session direction.
    if (snapshotApplied) return;

    const index = buildEditIndex(channel);

    for (const e of edits) {
      // Snapshot detection first — FULL_STATE path
      // produces edits with empty signature. Must
      // check before signature validation so late
      // joiners work even with trustedKeys.
      if (e.signature.length === 0) {
        if (applier.applySnapshot) {
          applier.applySnapshot(e.payload);
        }
        snapshotApplied = true;
        // No applySnapshot → skip silently. Creating
        // an Edit from snapshot bytes = data corruption.
        continue;
      }

      const hash = hexHash(sha256(e.payload));

      // Dedup: skip if we already have this edit
      if (index.has(hash)) continue;

      // Signature enforcement: when trustedKeys is
      // set, every edit must be verified. An empty
      // trustedKeys set means "trust no one."
      if (trustedKeys && verifySig) {
        const sig = e.signature;
        void verifySig(sig)
          .then((verifiedPayload) => {
            if (!verifiedPayload) return; // bad sig
            // Use the verified payload — it's what the
            // signature actually covers.
            const edit = EditCompanion.create({
              payload: verifiedPayload,
              timestamp: Date.now(),
              author: "",
              channel: channelName,
              origin: "sync",
              signature: sig,
            });
            applier.apply(edit);
          })
          .catch(() => {
            // Verification error — drop.
          });
        continue;
      }

      const edit = EditCompanion.create({
        payload: e.payload,
        timestamp: Date.now(),
        author: "",
        channel: channelName,
        origin: "sync",
        signature: e.signature,
      });
      applier.apply(edit);
    }
  }

  return {
    start,
    receive,
    get done() {
      // inDone: we received everything we need.
      // outDone: session returned null (in-sync) or
      // Edit[] (complete). The out direction is
      // purely reactive — it completes when the peer
      // stops querying, which we can't detect. Use
      // inDone as proxy: if both sides initiated and
      // our in-direction is done, the exchange is
      // complete.
      return inDone;
    },
  };
}
