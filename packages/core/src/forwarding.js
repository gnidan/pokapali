import * as dagCbor from "@ipld/dag-cbor";
import { signBytes, verifySignature, ed25519KeyPairFromSeed, } from "@pokapali/crypto";
export async function createForwardingRecord(oldIpnsName, newIpnsName, newUrl, rotationKey) {
    const signable = {
        oldIpnsName,
        newIpnsName,
        newUrl,
    };
    const payload = dagCbor.encode(signable);
    const keypair = await ed25519KeyPairFromSeed(rotationKey);
    const signature = await signBytes(keypair, payload);
    return { oldIpnsName, newIpnsName, newUrl, signature };
}
export function encodeForwardingRecord(record) {
    return dagCbor.encode(record);
}
export function decodeForwardingRecord(bytes) {
    return dagCbor.decode(bytes);
}
export async function verifyForwardingRecord(record, rotationKey) {
    try {
        const keypair = await ed25519KeyPairFromSeed(rotationKey);
        const signable = {
            oldIpnsName: record.oldIpnsName,
            newIpnsName: record.newIpnsName,
            newUrl: record.newUrl,
        };
        const payload = dagCbor.encode(signable);
        return verifySignature(keypair.publicKey, record.signature, payload);
    }
    catch {
        return false;
    }
}
// Module-level store for forwarding records.
// Keyed by old IPNS name → encoded forwarding record bytes.
const forwardingStore = new Map();
export function storeForwardingRecord(oldIpnsName, encoded) {
    forwardingStore.set(oldIpnsName, encoded);
}
export function lookupForwardingRecord(ipnsName) {
    return forwardingStore.get(ipnsName);
}
export function clearForwardingStore() {
    forwardingStore.clear();
}
//# sourceMappingURL=forwarding.js.map