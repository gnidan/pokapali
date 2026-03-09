import * as Y from "yjs";
import type { CID } from "multiformats/cid";
import {
  CID as CIDClass,
} from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  walkChain,
} from "@pokapali/snapshot";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { fetchBlock } from "./fetch-block.js";
import type { BlockGetter } from "./fetch-block.js";

const DAG_CBOR_CODE = 0x71;

export interface SnapshotLifecycleOptions {
  getHelia: () => BlockGetter;
}

export interface PushResult {
  cid: CID;
  seq: number;
  prev: CID | null;
  block: Uint8Array;
}

export interface SnapshotLifecycle {
  push(
    plaintext: Record<string, Uint8Array>,
    readKey: CryptoKey,
    signingKey: Ed25519KeyPair,
    clockSum: number,
  ): Promise<PushResult>;

  applyRemote(
    cid: CID,
    readKey: CryptoKey,
    onApply: (
      plaintext: Record<string, Uint8Array>,
    ) => void,
  ): Promise<boolean>;

  history(): Promise<
    Array<{ cid: CID; seq: number; ts: number }>
  >;

  loadVersion(
    cid: CID,
    readKey: CryptoKey,
  ): Promise<Record<string, Y.Doc>>;

  getBlock(cidStr: string): Uint8Array | undefined;
  putBlock(cidStr: string, block: Uint8Array): void;

  readonly prev: CID | null;
  readonly seq: number;
  readonly lastIpnsSeq: number | null;
  setLastIpnsSeq(seq: number): void;
}

export function createSnapshotLifecycle(
  options: SnapshotLifecycleOptions,
): SnapshotLifecycle {
  let seq = 1;
  let prev: CID | null = null;
  let lastIpnsSeq: number | null = null;
  const blocks = new Map<string, Uint8Array>();
  let lastAppliedCid: string | null = null;

  return {
    async push(
      plaintext,
      readKey,
      signingKey,
      clockSum,
    ): Promise<PushResult> {
      const prevForThis = prev;
      const seqForThis = seq;

      const block = await encodeSnapshot(
        plaintext,
        readKey,
        prevForThis,
        seqForThis,
        Date.now(),
        signingKey,
      );
      const hash = await sha256.digest(block);
      const cid = CIDClass.createV1(
        DAG_CBOR_CODE,
        hash,
      );

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

    async applyRemote(
      cid,
      readKey,
      onApply,
    ): Promise<boolean> {
      const cidStr = cid.toString();
      if (cidStr === lastAppliedCid) return false;

      const helia = options.getHelia();
      const block = await fetchBlock(helia, cid);

      const node = decodeSnapshot(block);
      const plaintext =
        await decryptSnapshot(node, readKey);

      blocks.set(cidStr, block);
      onApply(plaintext);

      if (node.seq >= seq) {
        prev = cid;
        seq = node.seq + 1;
      }

      lastAppliedCid = cidStr;
      return true;
    },

    async history() {
      if (!prev) return [];

      const getter = async (cid: CID) => {
        const block = blocks.get(cid.toString());
        if (!block) {
          throw new Error(
            "Block not found: " +
              cid.toString(),
          );
        }
        return block;
      };

      const entries: Array<{
        cid: CID;
        seq: number;
        ts: number;
      }> = [];
      let currentCid: CID | null = prev;
      for await (const node of walkChain(
        prev,
        getter,
      )) {
        entries.push({
          cid: currentCid!,
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
        } catch {
          throw new Error(
            "Unknown CID: " + cid.toString(),
          );
        }
      }
      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(
        node,
        readKey,
      );
      const result: Record<string, Y.Doc> = {};
      for (const [ns, bytes] of Object.entries(
        plaintext,
      )) {
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

    setLastIpnsSeq(s: number) {
      lastIpnsSeq = s;
    },
  };
}
