/**
 * Per-document snapshot exchange state machine.
 *
 * Peer of `coordinator.ts`: coordinator handles
 * per-channel edit reconciliation; this module
 * handles per-document snapshot CIDs (which span
 * all channels, encrypted together as one block).
 *
 * Flow:
 *   1. Each side sends a SNAPSHOT_CATALOG listing
 *      locally-available snapshot CIDs + current tip.
 *   2. On receiving a peer catalog, compute diff
 *      (CIDs peer has that we don't), apply selection
 *      policy, and send SNAPSHOT_REQUEST.
 *   3. On receiving a request, serve blocks in
 *      ~200KB chunks via SNAPSHOT_BLOCK. Unknown CIDs
 *      are NAK'd (empty block + total=0).
 *   4. On receiving blocks, reassemble by cid+offset,
 *      verify CID hash and snapshot signature, then
 *      hand the full block to the caller.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import { CID, sha256, validateSnapshot } from "@pokapali/blocks";
import {
  MessageType,
  type SnapshotCatalog,
  type SnapshotRequest,
  type SnapshotBlock,
} from "./messages.js";
import type { SnapshotMessage } from "./transport.js";

const log = createLogger("snapshot-exchange");

// 200KB default chunk. Picked to fit comfortably
// below the 256KB safe limit for WebRTC data channel
// messages (Chrome limits to 256KB; Firefox higher).
const DEFAULT_CHUNK_SIZE = 200_000;

// Per-reconciliation budget for request volume.
const DEFAULT_REQUEST_BUDGET = 10;

// -------------------------------------------------------
// Options / interface
// -------------------------------------------------------

export interface SnapshotCatalogEntry {
  cid: Uint8Array;
  seq: number;
  ts: number;
}

export interface SnapshotExchangeOptions {
  /** Send a snapshot message to the peer. */
  send: (msg: SnapshotMessage) => void;

  /**
   * Return local catalog summary: the set of snapshot
   * CIDs we can serve, plus our current tip CID (or
   * null if unknown).
   */
  getLocalCatalog: () => {
    entries: SnapshotCatalogEntry[];
    tip: Uint8Array | null;
  };

  /**
   * Fetch a local block by CID, or null if we don't
   * have it cached. Used both to serve requests and
   * to determine which CIDs we need to ask for.
   */
  getBlock: (cid: Uint8Array) => Uint8Array | null;

  /**
   * Invoked when a requested block has been fully
   * received, reassembled, and verified. The block
   * is ready for decryption and application.
   */
  onBlock: (cid: Uint8Array, data: Uint8Array) => void;

  /**
   * Override verification. Default: checks that
   * sha256(data) matches the CID's multihash digest
   * AND that validateSnapshot(data) succeeds.
   * Primarily for tests.
   */
  verify?: (cid: Uint8Array, data: Uint8Array) => Promise<boolean>;

  /** Outbound chunk size (bytes). Default 200KB. */
  chunkSize?: number;

  /** Max CIDs requested per received catalog. */
  requestBudget?: number;
}

export interface SnapshotExchange {
  /**
   * Send our local catalog to the peer. Typically
   * called once after the snapshot channel is ready;
   * may be called again to re-advertise when local
   * state changes.
   */
  advertise(): void;

  /** Handle an inbound snapshot message. */
  receive(msg: SnapshotMessage): void;

  /** Release buffers; suppress further callbacks. */
  destroy(): void;
}

// -------------------------------------------------------
// Implementation
// -------------------------------------------------------

interface PendingReassembly {
  cid: Uint8Array;
  total: number;
  chunks: Array<{ offset: number; data: Uint8Array }>;
  bytesReceived: number;
}

export function createSnapshotExchange(
  opts: SnapshotExchangeOptions,
): SnapshotExchange {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const budget = opts.requestBudget ?? DEFAULT_REQUEST_BUDGET;
  const verify = opts.verify ?? defaultVerify;

  // CID-hex → reassembly state
  const pending = new Map<string, PendingReassembly>();
  // CID-hex set: suppress duplicate outbound requests
  const requested = new Set<string>();

  let destroyed = false;

  function advertise(): void {
    if (destroyed) return;
    const { entries, tip } = opts.getLocalCatalog();
    log.debug(
      "advertise: entries=",
      entries.length,
      "tip=",
      tip ? hex(tip).slice(0, 12) : "null",
    );
    opts.send({
      type: MessageType.SNAPSHOT_CATALOG,
      entries,
      tip,
    });
  }

  function handleCatalog(msg: SnapshotCatalog): void {
    log.debug(
      "recv catalog: entries=",
      msg.entries.length,
      "tip=",
      msg.tip ? hex(msg.tip).slice(0, 12) : "null",
    );

    // Select CIDs we need. Tip-first, then newest-seq.
    const selected = selectCidsToRequest(msg, opts.getBlock, budget);

    // Dedupe against previously requested CIDs.
    const fresh: Uint8Array[] = [];
    for (const cid of selected) {
      const h = hex(cid);
      if (requested.has(h)) continue;
      requested.add(h);
      fresh.push(cid);
    }

    if (fresh.length === 0) {
      log.debug("no new CIDs to request");
      return;
    }
    log.debug("requesting", fresh.length, "CIDs");
    opts.send({
      type: MessageType.SNAPSHOT_REQUEST,
      cids: fresh,
    });
  }

  function handleRequest(msg: SnapshotRequest): void {
    log.debug("recv request: cids=", msg.cids.length);

    // Flatten (cid, block) into a list of chunks to send.
    // We iterate pairs with a trailing `last` flag: set
    // on the final chunk of the final entry.
    const chunks: SnapshotBlock[] = [];
    for (const cid of msg.cids) {
      const block = opts.getBlock(cid);
      if (block === null) {
        // NAK: empty block + total=0
        chunks.push({
          type: MessageType.SNAPSHOT_BLOCK,
          cid,
          block: new Uint8Array(0),
          offset: 0,
          total: 0,
          last: false,
        });
        continue;
      }
      // Chunk the block. A zero-length block is treated
      // as a NAK (since total=0 is the NAK signal) —
      // snapshot blocks are never empty in practice.
      if (block.length === 0) {
        chunks.push({
          type: MessageType.SNAPSHOT_BLOCK,
          cid,
          block: new Uint8Array(0),
          offset: 0,
          total: 0,
          last: false,
        });
        continue;
      }
      for (let offset = 0; offset < block.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, block.length);
        chunks.push({
          type: MessageType.SNAPSHOT_BLOCK,
          cid,
          block: block.subarray(offset, end),
          offset,
          total: block.length,
          last: false,
        });
      }
    }

    // Mark final chunk.
    const lastIdx = chunks.length - 1;
    if (lastIdx >= 0) {
      chunks[lastIdx] = { ...chunks[lastIdx]!, last: true };
    }

    for (const chunk of chunks) {
      opts.send(chunk);
    }
  }

  async function handleBlock(msg: SnapshotBlock): Promise<void> {
    const h = hex(msg.cid);

    // NAK: empty block + total=0. Peer can't serve this
    // CID; clear any pending reassembly and allow
    // re-requesting it from another peer/catalog.
    if (msg.total === 0) {
      log.debug("NAK for cid:", h.slice(0, 12));
      pending.delete(h);
      requested.delete(h);
      return;
    }

    // Bounds check: reject chunks that exceed total.
    if (msg.offset + msg.block.length > msg.total) {
      log.warn(
        "chunk exceeds total:",
        h.slice(0, 12),
        "offset=",
        msg.offset,
        "len=",
        msg.block.length,
        "total=",
        msg.total,
      );
      pending.delete(h);
      return;
    }

    let state = pending.get(h);
    if (!state) {
      state = {
        cid: msg.cid,
        total: msg.total,
        chunks: [],
        bytesReceived: 0,
      };
      pending.set(h, state);
    } else if (state.total !== msg.total) {
      // A peer changing total mid-stream is a protocol
      // error. Drop the reassembly; allow re-request.
      log.warn(
        "total mismatch for cid:",
        h.slice(0, 12),
        state.total,
        "!=",
        msg.total,
      );
      pending.delete(h);
      requested.delete(h);
      return;
    }

    state.chunks.push({ offset: msg.offset, data: msg.block });
    state.bytesReceived += msg.block.length;

    if (state.bytesReceived < state.total) return;

    // Reassemble in offset order.
    pending.delete(h);
    state.chunks.sort((a, b) => a.offset - b.offset);
    const full = new Uint8Array(state.total);
    for (const { offset, data } of state.chunks) {
      full.set(data, offset);
    }

    // Verify before handing off.
    const ok = await verify(msg.cid, full);
    if (destroyed) return;
    if (!ok) {
      log.warn("verification failed:", h.slice(0, 12));
      // Allow re-request from a different peer/catalog.
      requested.delete(h);
      return;
    }

    opts.onBlock(msg.cid, full);
  }

  return {
    advertise,

    receive(msg: SnapshotMessage): void {
      if (destroyed) return;
      switch (msg.type) {
        case MessageType.SNAPSHOT_CATALOG:
          handleCatalog(msg);
          break;
        case MessageType.SNAPSHOT_REQUEST:
          handleRequest(msg);
          break;
        case MessageType.SNAPSHOT_BLOCK:
          void handleBlock(msg);
          break;
      }
    },

    destroy(): void {
      destroyed = true;
      pending.clear();
      requested.clear();
    },
  };
}

// -------------------------------------------------------
// Selection policy
// -------------------------------------------------------

/**
 * Exported for testing. Applies the default request
 * policy: the tip first (if we don't have it), then
 * missing entries by descending seq, up to `budget`.
 */
export function selectCidsToRequest(
  peer: SnapshotCatalog,
  getBlock: (cid: Uint8Array) => Uint8Array | null,
  budget: number,
): Uint8Array[] {
  const out: Uint8Array[] = [];

  if (peer.tip && getBlock(peer.tip) === null) {
    out.push(peer.tip);
  }

  const missing = peer.entries.filter((e) => getBlock(e.cid) === null);
  missing.sort((a, b) => b.seq - a.seq);

  for (const e of missing) {
    if (out.length >= budget) break;
    // Skip the tip if we already added it above.
    if (peer.tip && bytesEqual(e.cid, peer.tip)) continue;
    out.push(e.cid);
  }

  return out;
}

// -------------------------------------------------------
// Default verification
// -------------------------------------------------------

async function defaultVerify(
  cidBytes: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  let cid: CID;
  try {
    cid = CID.decode(cidBytes);
  } catch (err) {
    log.debug("CID decode error:", (err as Error)?.message);
    return false;
  }
  const hash = await sha256.digest(data);
  if (!bytesEqual(cid.multihash.digest, hash.digest)) {
    log.debug("CID hash mismatch");
    return false;
  }
  const valid = await validateSnapshot(data);
  if (!valid) log.debug("validateSnapshot returned false");
  return valid;
}

// -------------------------------------------------------
// Utilities
// -------------------------------------------------------

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
