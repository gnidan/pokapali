/**
 * GossipSub reader for load testing.
 *
 * Subscribes to the announce topic and tracks received
 * announcements per ipnsName. Does NOT decode snapshots
 * — just verifies GossipSub message delivery.
 */

import { announceTopic, parseAnnouncement } from "@pokapali/core/announce";
import { createLogger } from "@pokapali/log";
import type { HeliaNode } from "./helia-node.js";

const log = createLogger("load-test:reader");

export interface ReaderEvent {
  type: "announcement-received" | "ack-received" | "error";
  readerId: string;
  timestampMs: number;
  ipnsName?: string;
  cid?: string;
  hasBlock?: boolean;
  error?: string;
}

export interface ReaderConfig {
  /** Application ID for GossipSub topic. */
  appId: string;
  /** Callback for event collection. */
  onEvent?: (event: ReaderEvent) => void;
}

export interface Reader {
  /** Unique reader identifier. */
  readonly readerId: string;
  /** Set of ipnsNames that sent announcements. */
  readonly seen: ReadonlySet<string>;
  /** Total announcements received. */
  readonly announcementCount: number;
  /** Stop the reader and unsubscribe. */
  stop(): void;
}

let readerCounter = 0;

export function startReader(helia: HeliaNode, config: ReaderConfig): Reader {
  const appId = config.appId;
  const onEvent = config.onEvent ?? (() => {});
  const readerId = `reader-${++readerCounter}`;

  const topic = announceTopic(appId);
  const pubsub = helia.libp2p.services.pubsub;
  pubsub.subscribe(topic);

  const seen = new Set<string>();
  let announcementCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messageHandler = (evt: any) => {
    if (evt.detail.topic !== topic) return;
    const announcement = parseAnnouncement(evt.detail.data);
    if (!announcement) return;

    if (announcement.ack) {
      onEvent({
        type: "ack-received",
        readerId,
        timestampMs: Date.now(),
        ipnsName: announcement.ipnsName,
        cid: announcement.cid,
      });
      return;
    }

    // Non-ack announcement = new snapshot
    seen.add(announcement.ipnsName);
    announcementCount++;

    onEvent({
      type: "announcement-received",
      readerId,
      timestampMs: Date.now(),
      ipnsName: announcement.ipnsName,
      cid: announcement.cid,
      hasBlock: !!announcement.block,
    });

    log.debug(
      `${readerId} received`,
      `ipns=${announcement.ipnsName.slice(0, 12)}...`,
      `cid=${announcement.cid.slice(0, 12)}...`,
    );
  };

  pubsub.addEventListener("message", messageHandler);

  log.info(`${readerId} started, subscribed to ${topic}`);

  return {
    readerId,
    get seen() {
      return seen as ReadonlySet<string>;
    },
    get announcementCount() {
      return announcementCount;
    },
    stop() {
      pubsub.removeEventListener("message", messageHandler);
      pubsub.unsubscribe(topic);
      log.info(`${readerId} stopped`);
    },
  };
}
