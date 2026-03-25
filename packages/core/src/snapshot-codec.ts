import * as Y from "yjs";
import type { CID } from "multiformats/cid";
import { CID as CIDClass } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
} from "@pokapali/blocks";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { createLogger } from "@pokapali/log";
import type { BlockResolver } from "./block-resolver.js";
import { NotFoundError } from "./errors.js";

const log = createLogger("snapshot-codec");

const DAG_CBOR_CODE = 0x71;

export interface SnapshotCodecOptions {
  resolver: BlockResolver;
}

export interface PushResult {
  cid: CID;
  seq: number;
  prev: CID | null;
  block: Uint8Array;
}

export interface SnapshotCodec {
  push(
    plaintext: Record<string, Uint8Array>,
    readKey: CryptoKey,
    signingKey: Ed25519KeyPair,
    clockSum: number,
    identityKey?: Ed25519KeyPair,
  ): Promise<PushResult>;

  applyRemote(
    cid: CID,
    readKey: CryptoKey,
    onApply: (plaintext: Record<string, Uint8Array>) => void,
  ): Promise<boolean>;

  loadVersion(cid: CID, readKey: CryptoKey): Promise<Record<string, Y.Doc>>;

  readonly prev: CID | null;
  readonly seq: number;
  readonly lastIpnsSeq: number | null;
  setLastIpnsSeq(seq: number): void;
}

export function createSnapshotCodec(
  options: SnapshotCodecOptions,
): SnapshotCodec {
  let seq = 1;
  let prev: CID | null = null;
  let lastIpnsSeq: number | null = null;
  const MAX_DECODED_CACHE = 10;
  const decodedVersions = new Map<string, Record<string, Y.Doc>>();
  let lastAppliedCid: string | null = null;
  const resolver = options.resolver;

  return {
    async push(
      plaintext,
      readKey,
      signingKey,
      clockSum,
      identityKey,
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
        identityKey,
      );
      const hash = await sha256.digest(block);
      const cid = CIDClass.createV1(DAG_CBOR_CODE, hash);

      resolver.put(cid, block);
      lastAppliedCid = cid.toString();
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

    async applyRemote(cid, readKey, onApply): Promise<boolean> {
      const cidStr = cid.toString();
      if (cidStr === lastAppliedCid) return false;

      const block = await resolver.get(cid);
      if (!block || block.length === 0) {
        log.warn("block not found for", cidStr);
        return false;
      }

      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(node, readKey);

      // resolver.put() already happened inside
      // resolver.get() when it fetched the block.
      // Explicit put ensures memory cache is warm
      // if the block came from an external caller.
      resolver.put(cid, block);

      onApply(plaintext);

      if (node.seq >= seq) {
        prev = cid;
        seq = node.seq + 1;
      }

      lastAppliedCid = cidStr;
      return true;
    },

    async loadVersion(cid, readKey) {
      const cidStr = cid.toString();

      // Return cached decoded version — avoids
      // redundant decrypt + Y.Doc creation when
      // the same version is loaded multiple times
      // (e.g. preload then click in diff view).
      const decoded = decodedVersions.get(cidStr);
      if (decoded) return decoded;

      const block = await resolver.get(cid);
      if (!block || block.length === 0) {
        throw new NotFoundError(
          "Block not found: " +
            cidStr +
            " — the snapshot data could not be" +
            " retrieved from the network or local" +
            " storage. The version may no longer" +
            " be available from any connected peer",
        );
      }

      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(node, readKey);
      const result: Record<string, Y.Doc> = {};
      for (const [ns, bytes] of Object.entries(plaintext)) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        result[ns] = doc;
      }
      if (decodedVersions.size >= MAX_DECODED_CACHE) {
        // Evict oldest entry (first key in Map
        // insertion order).
        const oldest = decodedVersions.keys().next();
        if (!oldest.done) decodedVersions.delete(oldest.value);
      }
      decodedVersions.set(cidStr, result);
      return result;
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
