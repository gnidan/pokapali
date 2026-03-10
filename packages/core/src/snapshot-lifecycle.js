import * as Y from "yjs";
import { CID as CIDClass, } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeSnapshot, decodeSnapshot, decryptSnapshot, walkChain, } from "@pokapali/snapshot";
import { fetchBlock } from "./fetch-block.js";
const DAG_CBOR_CODE = 0x71;
export function createSnapshotLifecycle(options) {
    let seq = 1;
    let prev = null;
    let lastIpnsSeq = null;
    const blocks = new Map();
    let lastAppliedCid = null;
    return {
        async push(plaintext, readKey, signingKey, clockSum) {
            const prevForThis = prev;
            const seqForThis = seq;
            const block = await encodeSnapshot(plaintext, readKey, prevForThis, seqForThis, Date.now(), signingKey);
            const hash = await sha256.digest(block);
            const cid = CIDClass.createV1(DAG_CBOR_CODE, hash);
            const cidStr = cid.toString();
            blocks.set(cidStr, block);
            lastAppliedCid = cidStr;
            lastIpnsSeq = clockSum;
            prev = cid;
            seq++;
            return {
                cid,
                seq: seqForThis,
                prev: prevForThis,
                block,
            };
        },
        async applyRemote(cid, readKey, onApply) {
            const cidStr = cid.toString();
            if (cidStr === lastAppliedCid)
                return false;
            const helia = options.getHelia();
            const block = await fetchBlock(helia, cid);
            const node = decodeSnapshot(block);
            const plaintext = await decryptSnapshot(node, readKey);
            blocks.set(cidStr, block);
            // Serve the validated block to other peers
            // via bitswap.
            if (helia.blockstore.put) {
                Promise.resolve(helia.blockstore.put(cid, block)).catch(() => { });
            }
            onApply(plaintext);
            if (node.seq >= seq) {
                prev = cid;
                seq = node.seq + 1;
            }
            lastAppliedCid = cidStr;
            return true;
        },
        async history() {
            if (!prev)
                return [];
            const getter = async (cid) => {
                const block = blocks.get(cid.toString());
                if (!block) {
                    throw new Error("Block not found: " +
                        cid.toString());
                }
                return block;
            };
            const entries = [];
            let currentCid = prev;
            for await (const node of walkChain(prev, getter)) {
                entries.push({
                    cid: currentCid,
                    seq: node.seq,
                    ts: node.ts,
                });
                currentCid = node.prev;
            }
            return entries;
        },
        async loadVersion(cid, readKey) {
            let block = blocks.get(cid.toString());
            if (!block) {
                try {
                    const helia = options.getHelia();
                    block =
                        await helia.blockstore.get(cid);
                }
                catch {
                    throw new Error("Unknown CID: " + cid.toString());
                }
            }
            const node = decodeSnapshot(block);
            const plaintext = await decryptSnapshot(node, readKey);
            const result = {};
            for (const [ns, bytes] of Object.entries(plaintext)) {
                const doc = new Y.Doc();
                Y.applyUpdate(doc, bytes);
                result[ns] = doc;
            }
            return result;
        },
        getBlock(cidStr) {
            return blocks.get(cidStr);
        },
        putBlock(cidStr, block) {
            blocks.set(cidStr, block);
        },
        get prev() {
            return prev;
        },
        get seq() {
            return seq;
        },
        get lastIpnsSeq() {
            return lastIpnsSeq;
        },
        setLastIpnsSeq(s) {
            lastIpnsSeq = s;
        },
    };
}
//# sourceMappingURL=snapshot-lifecycle.js.map