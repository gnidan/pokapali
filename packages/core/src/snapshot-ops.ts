/**
 * snapshot-ops.ts — Snapshot-related effect handlers,
 * extracted from create-doc.ts to decouple
 * interpreter.ts from snapshot-codec internals.
 *
 * Provides the SnapshotOps interface (a subset of
 * EffectHandlers) and a factory that wires up the
 * concrete implementations from SnapshotCodec +
 * BlockResolver.
 */

import type { CID } from "multiformats/cid";
import { decodeSnapshot, validateSnapshot } from "@pokapali/blocks";
import { bytesToHex } from "@pokapali/crypto";
import { createLogger } from "@pokapali/log";
import type { SnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";
import type { Document } from "@pokapali/document";
import { ValidationError } from "./errors.js";

const log = createLogger("snapshot-ops");

/** Thrown when a snapshot block fails Ed25519
 *  signature validation. */
export class SnapshotValidationError extends ValidationError {
  override name = "SnapshotValidationError" as const;
  constructor(public readonly cid: string) {
    super(`Snapshot block failed signature validation: ` + cid);
  }
}

// ------------------------------------------------
// BlockMetadata — decoded snapshot header fields
// ------------------------------------------------

export interface BlockMetadata {
  prev?: CID;
  seq?: number;
  snapshotTs?: number;
  /** Hex-encoded publisher identity pubkey,
   *  if present in the snapshot. */
  publisher?: string;
}

// ------------------------------------------------
// SnapshotOps — the snapshot subset of
// EffectHandlers
// ------------------------------------------------

export interface SnapshotOps {
  decodeBlock(block: Uint8Array): BlockMetadata;

  applySnapshot(cid: CID, block: Uint8Array): Promise<{ seq: number }>;
}

// ------------------------------------------------
// Factory
// ------------------------------------------------

export interface SnapshotOpsOptions {
  snapshotCodec: SnapshotCodec;
  document?: Document;
  resolver: BlockResolver;
  readKey: CryptoKey;
  getClockSum: () => number;
}

export function createSnapshotOps(options: SnapshotOpsOptions): SnapshotOps {
  const { snapshotCodec, document, resolver, readKey, getClockSum } = options;

  return {
    decodeBlock(block: Uint8Array): BlockMetadata {
      try {
        const node = decodeSnapshot(block);
        const publisher = node.publisher
          ? bytesToHex(node.publisher)
          : undefined;
        return {
          prev: node.prev ?? undefined,
          seq: node.seq,
          snapshotTs: node.ts,
          publisher,
        };
      } catch {
        return {};
      }
    },

    async applySnapshot(cid: CID, block: Uint8Array): Promise<{ seq: number }> {
      const valid = await validateSnapshot(block);
      if (!valid) {
        const cidStr = cid.toString();
        log.debug(
          "rejecting snapshot: failed validation",
          cidStr.slice(0, 16) + "...",
        );
        throw new SnapshotValidationError(cidStr);
      }

      resolver.put(cid, block);

      const applied = await snapshotCodec.applyRemote(
        cid,
        readKey,
        (plaintext) => {
          if (document) {
            for (const [ch, state] of Object.entries(plaintext)) {
              document.channel(ch).appendSnapshot(state);
              if (document.hasSurface(ch)) {
                document.surface(ch).applyState(state);
              }
            }
          }
        },
      );

      if (applied) {
        snapshotCodec.setLastIpnsSeq(getClockSum());
      }

      const node = decodeSnapshot(block);
      return { seq: node.seq };
    },
  };
}
