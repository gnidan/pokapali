/**
 * Simulated document writer for load testing.
 *
 * Creates a Y.Doc, makes periodic random edits,
 * encodes snapshots, announces on GossipSub with
 * inline blocks, and listens for pinner acks.
 */

import * as Y from "yjs";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
import {
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  generateAdminSecret,
  bytesToHex,
} from "@pokapali/crypto";
import { encodeSnapshot } from "@pokapali/snapshot";
import {
  announceTopic,
  announceSnapshot,
  parseAnnouncement,
  MAX_INLINE_BLOCK_BYTES,
} from "@pokapali/core/announce";
import { uploadBlock } from "@pokapali/core/block-upload";
import { createLogger } from "@pokapali/log";
import type { HeliaNode } from "./helia-node.js";

const DAG_CBOR_CODE = 0x71;
const log = createLogger("load-test:writer");

export interface WriterEvent {
  type: "edit" | "snapshot-pushed" | "announced" | "ack-received" | "error";
  writerId: string;
  timestampMs: number;
  /** Elapsed ms for the operation. */
  durationMs?: number;
  cid?: string;
  seq?: number;
  ackerPeerId?: string;
  /** ms epoch until pinner re-announces. */
  guaranteeUntil?: number;
  /** ms epoch until pinner retains blocks. */
  retainUntil?: number;
  error?: string;
}

export interface WriterConfig {
  /** Application ID for GossipSub topic. */
  appId: string;
  /** Interval between edits in ms. Default 10_000. */
  editIntervalMs?: number;
  /** Bytes of random text per edit. Default 100. */
  editSizeBytes?: number;
  /** HTTP block endpoint URLs for uploading
   *  blocks that exceed the inline limit. */
  httpUrls?: string[];
  /** Callback for metrics/event collection. */
  onEvent?: (event: WriterEvent) => void;
}

export interface Writer {
  /** Hex-encoded IPNS public key. */
  readonly ipnsName: string;
  /** Unique writer identifier. */
  readonly writerId: string;
  /** Stop the writer loop and unsubscribe. */
  stop(): void;
}

export async function startWriter(
  helia: HeliaNode,
  config: WriterConfig,
): Promise<Writer> {
  const appId = config.appId;
  const editInterval = config.editIntervalMs ?? 10_000;
  const editSize = config.editSizeBytes ?? 100;
  const httpUrls = config.httpUrls ?? [];
  const onEvent = config.onEvent ?? (() => {});

  // Generate fresh identity
  const adminSecret = generateAdminSecret();
  const keys = await deriveDocKeys(adminSecret, appId, ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  const ipnsName = bytesToHex(signingKey.publicKey);
  const writerId = ipnsName.slice(0, 12);

  log.info(
    `writer ${writerId} starting,`,
    `appId=${appId},`,
    `interval=${editInterval}ms`,
  );

  // Create Y.Doc
  const doc = new Y.Doc();
  const text = doc.getText("content");

  // Snapshot state
  let seq = 1;
  let prev: CID | null = null;
  let stopped = false;

  // Subscribe to announce topic for acks
  const topic = announceTopic(appId);
  const pubsub = helia.libp2p.services.pubsub;
  pubsub.subscribe(topic);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messageHandler = (evt: any) => {
    if (evt.detail.topic !== topic) return;
    const announcement = parseAnnouncement(evt.detail.data);
    if (!announcement) return;
    if (announcement.ipnsName !== ipnsName) return;
    if (!announcement.ack) return;

    onEvent({
      type: "ack-received",
      writerId,
      timestampMs: Date.now(),
      cid: announcement.cid,
      ackerPeerId: announcement.ack.peerId,
      guaranteeUntil: announcement.ack.guaranteeUntil,
      retainUntil: announcement.ack.retainUntil,
    });
    log.info(
      `writer ${writerId} ack from`,
      announcement.ack.peerId.slice(-8),
      `cid=${announcement.cid.slice(0, 12)}...`,
    );
  };
  pubsub.addEventListener("message", messageHandler);

  // Random text generator
  function randomText(size: number): string {
    const chars =
      "abcdefghijklmnopqrstuvwxyz" +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
      "0123456789 \n";
    let result = "";
    const bytes = new Uint8Array(size);
    // getRandomValues has a 65536-byte limit
    const CHUNK = 65536;
    for (let off = 0; off < size; off += CHUNK) {
      const end = Math.min(off + CHUNK, size);
      crypto.getRandomValues(bytes.subarray(off, end));
    }
    for (let i = 0; i < size; i++) {
      result += chars[bytes[i] % chars.length];
    }
    return result;
  }

  async function editAndPush() {
    if (stopped) return;

    const editStart = Date.now();

    // Make a random edit
    text.insert(text.length, randomText(editSize));

    onEvent({
      type: "edit",
      writerId,
      timestampMs: Date.now(),
      durationMs: Date.now() - editStart,
    });

    // Encode snapshot
    const pushStart = Date.now();
    try {
      const state = Y.encodeStateAsUpdate(doc);
      const plaintext: Record<string, Uint8Array> = { content: state };

      const seqForThis = seq;
      const prevForThis = prev;

      const block = await encodeSnapshot(
        plaintext,
        keys.readKey,
        prevForThis,
        seqForThis,
        Date.now(),
        signingKey,
      );
      const hash = await sha256.digest(block);
      const cid = CID.createV1(DAG_CBOR_CODE, hash);
      const cidStr = cid.toString();

      // Store in blockstore
      await helia.blockstore.put(cid, block);

      prev = cid;
      seq++;

      onEvent({
        type: "snapshot-pushed",
        writerId,
        timestampMs: Date.now(),
        durationMs: Date.now() - pushStart,
        cid: cidStr,
        seq: seqForThis,
      });

      // Upload + announce
      const announceStart = Date.now();
      const clockSum = text.length;

      if (block.length > MAX_INLINE_BLOCK_BYTES && httpUrls.length > 0) {
        // Large block: upload via HTTP first,
        // then announce without inline data.
        await uploadBlock(cid, block, httpUrls);
        await announceSnapshot(pubsub, appId, ipnsName, cidStr, clockSum);
      } else {
        // Fits inline — announce with block data.
        await announceSnapshot(
          pubsub,
          appId,
          ipnsName,
          cidStr,
          clockSum,
          block,
        );
      }

      onEvent({
        type: "announced",
        writerId,
        timestampMs: Date.now(),
        durationMs: Date.now() - announceStart,
        cid: cidStr,
        seq: seqForThis,
      });

      log.debug(
        `writer ${writerId} announced`,
        `seq=${seqForThis}`,
        `cid=${cidStr.slice(0, 12)}...`,
        `block=${block.length}B`,
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      onEvent({
        type: "error",
        writerId,
        timestampMs: Date.now(),
        error: msg,
      });
      log.error(`writer ${writerId} error:`, msg);
    }
  }

  // Initial edit + push
  editAndPush();

  // Periodic loop
  const timer = setInterval(editAndPush, editInterval);

  return {
    ipnsName,
    writerId,
    stop() {
      stopped = true;
      clearInterval(timer);
      pubsub.removeEventListener("message", messageHandler);
      pubsub.unsubscribe(topic);
      log.info(`writer ${writerId} stopped`);
    },
  };
}
