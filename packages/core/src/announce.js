/**
 * Announce snapshot availability over GossipSub.
 *
 * Writers publish an announcement whenever they push a
 * new IPNS record. Pinners subscribe to the topic and
 * resolve the IPNS name to fetch blocks.
 */
/**
 * Build the GossipSub topic for snapshot announcements
 * within a given app.
 */
export function announceTopic(appId) {
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
const MAX_INLINE_BLOCK_BYTES = 256 * 1024;
function uint8ToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
export function base64ToUint8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
export async function announceSnapshot(pubsub, appId, ipnsName, cid, seq, block, fromPinner, ack) {
    const topic = announceTopic(appId);
    const msg = { ipnsName, cid };
    if (seq !== undefined)
        msg.seq = seq;
    if (block && block.length <= MAX_INLINE_BLOCK_BYTES) {
        msg.block = uint8ToBase64(block);
    }
    if (fromPinner)
        msg.fromPinner = true;
    if (ack)
        msg.ack = ack;
    const data = new TextEncoder().encode(JSON.stringify(msg));
    await pubsub.publish(topic, data);
}
/**
 * Publish a pinner acknowledgment on GossipSub.
 * Sent after a pinner successfully fetches and
 * validates a snapshot block.
 */
export async function announceAck(pubsub, appId, ipnsName, cid, peerId, guaranteeUntil, retainUntil) {
    const topic = announceTopic(appId);
    const ack = { peerId };
    if (guaranteeUntil !== undefined) {
        ack.guaranteeUntil = guaranteeUntil;
    }
    if (retainUntil !== undefined) {
        ack.retainUntil = retainUntil;
    }
    const msg = {
        ipnsName,
        cid,
        ack,
    };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    await pubsub.publish(topic, data);
}
/**
 * Parse a raw announcement message payload.
 *
 * @returns parsed Announcement or null if invalid
 */
export function parseAnnouncement(data) {
    try {
        const text = new TextDecoder().decode(data);
        const obj = JSON.parse(text);
        if (typeof obj.ipnsName === "string" &&
            typeof obj.cid === "string") {
            return obj;
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=announce.js.map