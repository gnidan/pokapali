/**
 * Announce snapshot availability over GossipSub.
 *
 * Writers publish an announcement whenever they push a
 * new IPNS record. Pinners subscribe to the topic and
 * resolve the IPNS name to fetch blocks.
 */

/**
 * Minimal pubsub interface — only publish is needed by
 * the announcer. Kept compatible with PubSubLike from
 * @pokapali/sync but avoids requiring the full interface.
 */
export interface AnnouncePubSub {
  publish(
    topic: string,
    data: Uint8Array,
  ): Promise<unknown>;
}

export interface Announcement {
  ipnsName: string;
  cid: string;
  seq?: number;
}

/**
 * Build the GossipSub topic for snapshot announcements
 * within a given app.
 */
export function announceTopic(appId: string): string {
  return `/pokapali/app/${appId}/announce`;
}

/**
 * Publish a snapshot announcement on GossipSub.
 *
 * @param pubsub   GossipSub-compatible publish interface
 * @param appId    application identifier
 * @param ipnsName hex-encoded IPNS public key
 * @param cid      CID string of the published snapshot
 */
export async function announceSnapshot(
  pubsub: AnnouncePubSub,
  appId: string,
  ipnsName: string,
  cid: string,
  seq?: number,
): Promise<void> {
  const topic = announceTopic(appId);
  const msg: Announcement = { ipnsName, cid };
  if (seq !== undefined) msg.seq = seq;
  const data = new TextEncoder().encode(
    JSON.stringify(msg),
  );
  await pubsub.publish(topic, data);
}

/**
 * Parse a raw announcement message payload.
 *
 * @returns parsed Announcement or null if invalid
 */
export function parseAnnouncement(
  data: Uint8Array,
): Announcement | null {
  try {
    const text = new TextDecoder().decode(data);
    const obj = JSON.parse(text);
    if (
      typeof obj.ipnsName === "string" &&
      typeof obj.cid === "string"
    ) {
      return obj as Announcement;
    }
    return null;
  } catch {
    return null;
  }
}
