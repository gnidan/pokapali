/**
 * Active reader peer for load testing.
 *
 * Subscribes to GossipSub, decodes inline snapshot
 * blocks, decrypts and applies Yjs state, verifies
 * convergence via clockSum comparison.
 */

import * as Y from "yjs";
import {
  parseAnnouncement,
  announceTopic,
  base64ToUint8,
} from "@pokapali/core/announce";
import { decodeSnapshot, decryptSnapshot } from "@pokapali/blocks";
import { createLogger } from "@pokapali/log";

const log = createLogger("load-test:reader-peer");

export interface ReaderPeerEvent {
  type: "reader-synced" | "convergence-ok" | "convergence-drift" | "error";
  peerId: string;
  timestampMs: number;
  ipnsName?: string;
  cid?: string;
  latencyMs?: number;
  expectedClockSum?: number;
  actualClockSum?: number;
  error?: string;
}

export interface ReaderPeerConfig {
  /** Application ID for GossipSub topic. */
  appId: string;
  /** Map of ipnsName → readKey for writers. */
  writers: ReadonlyMap<string, CryptoKey>;
  /** Callback for event collection. */
  onEvent?: (event: ReaderPeerEvent) => void;
}

export interface ReaderPeer {
  /** Unique peer identifier. */
  readonly peerId: string;
  /** ipnsNames successfully synced. */
  readonly syncedDocs: ReadonlySet<string>;
  /** Count of convergence mismatches. */
  readonly convergenceErrors: number;
  /** Stop the reader peer and unsubscribe. */
  stop(): void;
}

interface PubSubLike {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  addEventListener(type: string, handler: (evt: unknown) => void): void;
  removeEventListener(type: string, handler: (evt: unknown) => void): void;
}

let peerCounter = 0;

export function startReaderPeer(
  pubsub: PubSubLike,
  config: ReaderPeerConfig,
): ReaderPeer {
  const appId = config.appId;
  const writers = config.writers;
  const onEvent = config.onEvent ?? (() => {});
  const peerId = `reader-peer-${++peerCounter}`;

  const topic = announceTopic(appId);
  pubsub.subscribe(topic);

  const syncedDocs = new Set<string>();
  let convergenceErrors = 0;

  const docs = new Map<string, Y.Doc>();

  function getOrCreateDoc(ipnsName: string): Y.Doc {
    let doc = docs.get(ipnsName);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(ipnsName, doc);
    }
    return doc;
  }

  const messageHandler = (evt: unknown) => {
    const detail =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (evt as any)?.detail;
    if (!detail || detail.topic !== topic) return;

    const announcement = parseAnnouncement(detail.data);
    if (!announcement) return;

    if (announcement.ack) return;

    const readKey = writers.get(announcement.ipnsName);
    if (!readKey) return;

    if (!announcement.block) return;

    const receiveTs = Date.now();

    processAnnouncement(
      announcement.ipnsName,
      announcement.cid,
      announcement.block,
      announcement.seq,
      readKey,
      receiveTs,
    ).catch((err) => {
      onEvent({
        type: "error",
        peerId,
        timestampMs: Date.now(),
        ipnsName: announcement.ipnsName,
        cid: announcement.cid,
        error: (err as Error).message ?? String(err),
      });
    });
  };

  async function processAnnouncement(
    ipnsName: string,
    cid: string,
    blockB64: string,
    expectedClockSum: number | undefined,
    readKey: CryptoKey,
    receiveTs: number,
  ): Promise<void> {
    const blockBytes = base64ToUint8(blockB64);
    const node = decodeSnapshot(blockBytes);
    const plaintext = await decryptSnapshot(node, readKey);

    const contentUpdate = plaintext["content"];
    if (!contentUpdate) return;

    const doc = getOrCreateDoc(ipnsName);
    Y.applyUpdate(doc, contentUpdate);

    syncedDocs.add(ipnsName);

    const actualClockSum = doc.getText("content").length;
    const latencyMs = Date.now() - receiveTs;

    onEvent({
      type: "reader-synced",
      peerId,
      timestampMs: Date.now(),
      ipnsName,
      cid,
      latencyMs,
    });

    log.debug(
      `${peerId} synced`,
      `ipns=${ipnsName.slice(0, 12)}...`,
      `cid=${cid.slice(0, 12)}...`,
      `latency=${latencyMs}ms`,
    );

    if (expectedClockSum !== undefined) {
      if (actualClockSum === expectedClockSum) {
        onEvent({
          type: "convergence-ok",
          peerId,
          timestampMs: Date.now(),
          ipnsName,
          cid,
          expectedClockSum,
          actualClockSum,
        });
      } else {
        convergenceErrors++;
        onEvent({
          type: "convergence-drift",
          peerId,
          timestampMs: Date.now(),
          ipnsName,
          cid,
          expectedClockSum,
          actualClockSum,
        });
        log.warn(
          `${peerId} convergence drift`,
          `ipns=${ipnsName.slice(0, 12)}...`,
          `expected=${expectedClockSum}`,
          `actual=${actualClockSum}`,
        );
      }
    }
  }

  pubsub.addEventListener("message", messageHandler);

  log.info(`${peerId} started,`, `tracking ${writers.size} writer(s)`);

  return {
    peerId,
    get syncedDocs() {
      return syncedDocs as ReadonlySet<string>;
    },
    get convergenceErrors() {
      return convergenceErrors;
    },
    stop() {
      pubsub.removeEventListener("message", messageHandler);
      pubsub.unsubscribe(topic);
      for (const doc of docs.values()) {
        doc.destroy();
      }
      docs.clear();
      log.info(`${peerId} stopped`);
    },
  };
}
