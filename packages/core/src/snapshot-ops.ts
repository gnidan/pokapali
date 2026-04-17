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
import { decodeSnapshot } from "@pokapali/blocks";
import { bytesToHex } from "@pokapali/crypto";
import { createLogger } from "@pokapali/log";
import type { IngestSnapshotApi } from "./ingest-snapshot.js";
import { PendingIngestError } from "./ingest-snapshot.js";
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
  /**
   * Unified ingestion API (from `createIngestSnapshot`).
   * `applySnapshot` delegates the full validate / dedupe
   * / place / apply pipeline here — this struct's
   * applySnapshot is a thin interpreter-facing shim that
   * maps ingest outcomes back to the legacy `{seq}`
   * return shape.
   */
  ingest: IngestSnapshotApi;
  /**
   * Source dispatch (Option Y, architect ratified
   * 2026-04-16): returns "local" if `cid` matches the
   * last locally-published CID, else "peer". Post-A4,
   * peer blocks primarily arrive via catalog exchange →
   * onSnapshotReceived → ingestSnapshot (bypassing this
   * shim). The GossipSub path still reaches here for
   * backward compatibility until the interpreter-double-
   * apply cutover removes it.
   */
  resolveSource: (cid: CID) => "local" | "peer";
}

export function createSnapshotOps(options: SnapshotOpsOptions): SnapshotOps {
  const { ingest, resolveSource } = options;

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
      const source = resolveSource(cid);
      const result = await ingest.ingestSnapshot(cid, block, { source });

      if (result.outcome === "rejected") {
        // cid-mismatch + invalid-signature → same
        // SnapshotValidationError the interpreter
        // already handles. "duplicate" is a benign
        // no-op — return {seq} like the legacy path did.
        if (
          result.reason === "cid-mismatch" ||
          result.reason === "invalid-signature"
        ) {
          const cidStr = cid.toString();
          log.debug(
            "rejecting snapshot: " + (result.reason ?? "unknown"),
            cidStr.slice(0, 16) + "...",
          );
          throw new SnapshotValidationError(cidStr);
        }
        // "duplicate" or "pending-overflow" — fall
        // through to seq decode. (pending-overflow on
        // an applySnapshot path is exceptional; the
        // caller sees it as a successful no-op since
        // the block never actually placed. The orchestrator
        // already recorded the terminal metric.)
      }

      if (result.outcome === "pending") {
        // Signal to the interpreter that tip must NOT
        // advance — the block is quarantined awaiting
        // a bridging epoch.
        throw new PendingIngestError(cid.toString());
      }

      // "placed" (or benign rejected above) — surface
      // the seq so the interpreter can push tip-advanced.
      const node = decodeSnapshot(block);
      return { seq: node.seq };
    },
  };
}
