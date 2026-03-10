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
    publish(topic: string, data: Uint8Array): Promise<unknown>;
}
export interface AnnouncementAck {
    peerId: string;
    /** Absolute timestamp (ms since epoch) until which
     *  the pinner guarantees service for this doc. */
    guaranteeUntil?: number;
    /** Unix timestamp (ms) until which the pinner
     *  will retain the block (requested by writer,
     *  before full guarantee is confirmed). */
    retainUntil?: number;
}
export interface Announcement {
    ipnsName: string;
    cid: string;
    seq?: number;
    ack?: AnnouncementAck;
    /** Base64-encoded snapshot block data. */
    block?: string;
    /** True when this announcement originates from
     *  a pinner (re-announce), not a writer. */
    fromPinner?: boolean;
}
/**
 * Build the GossipSub topic for snapshot announcements
 * within a given app.
 */
export declare function announceTopic(appId: string): string;
export declare function base64ToUint8(b64: string): Uint8Array;
export declare function announceSnapshot(pubsub: AnnouncePubSub, appId: string, ipnsName: string, cid: string, seq?: number, block?: Uint8Array): Promise<void>;
/**
 * Publish a pinner acknowledgment on GossipSub.
 * Sent after a pinner successfully fetches and
 * validates a snapshot block.
 */
export interface AnnounceAckOptions {
    guaranteeUntil?: number;
    retainUntil?: number;
}
export declare function announceAck(pubsub: AnnouncePubSub, appId: string, ipnsName: string, cid: string, peerId: string, options?: AnnounceAckOptions): Promise<void>;
/**
 * Parse a raw announcement message payload.
 *
 * @returns parsed Announcement or null if invalid
 */
export declare function parseAnnouncement(data: Uint8Array): Announcement | null;
//# sourceMappingURL=announce.d.ts.map