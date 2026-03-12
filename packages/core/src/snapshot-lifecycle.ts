import * as Y from "yjs";
import type { CID } from "multiformats/cid";
import { CID as CIDClass } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
} from "@pokapali/snapshot";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { createLogger } from "@pokapali/log";
import { fetchBlock } from "./fetch-block.js";
import type { BlockGetter } from "./fetch-block.js";

const log = createLogger("snapshot-lifecycle");

const DAG_CBOR_CODE = 0x71;

export interface SnapshotLifecycleOptions {
  getHelia: () => BlockGetter;
  /** Dynamic getter for HTTP block endpoint URLs
   *  (from node registry caps). Used as fallback
   *  when blockstore retries fail. */
  httpUrls?: () => string[];
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
    identityKey?: Ed25519KeyPair,
  ): Promise<PushResult>;

  applyRemote(
    cid: CID,
    readKey: CryptoKey,
    onApply: (plaintext: Record<string, Uint8Array>) => void,
  ): Promise<boolean>;

  loadVersion(cid: CID, readKey: CryptoKey): Promise<Record<string, Y.Doc>>;

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
  const decodedVersions = new Map<string, Record<string, Y.Doc>>();
  let lastAppliedCid: string | null = null;

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

      // identityKey is forwarded for publisher
      // attribution once snapshot package supports it
      // (protocol branch). The cast handles the
      // transition period before merge.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      const encode = encodeSnapshot as Function;
      const block = (await encode(
        plaintext,
        readKey,
        prevForThis,
        seqForThis,
        Date.now(),
        signingKey,
        identityKey,
      )) as Uint8Array;
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

    async applyRemote(cid, readKey, onApply): Promise<boolean> {
      const cidStr = cid.toString();
      if (cidStr === lastAppliedCid) return false;

      const helia = options.getHelia();
      const block = await fetchBlock(helia, cid, {
        httpUrls: options.httpUrls?.(),
      });
      if (block.length === 0) {
        log.warn("empty block for", cidStr);
        return false;
      }

      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(node, readKey);

      blocks.set(cidStr, block);

      // Serve the validated block to other peers
      // via bitswap.
      if (helia.blockstore.put) {
        Promise.resolve(helia.blockstore.put(cid, block)).catch(
          (err: unknown) => log.warn("blockstore.put failed:", err),
        );
      }

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

      const cached = blocks.get(cidStr);
      let block: Uint8Array | undefined =
        cached && cached.length > 0 ? cached : undefined;
      if (!block) {
        const helia = options.getHelia();
        try {
          block = await fetchBlock(helia, cid, {
            httpUrls: options.httpUrls?.(),
            retries: 2,
            baseMs: 1_000,
          });
        } catch {
          throw new Error("Block not found: " + cidStr);
        }
        blocks.set(cidStr, block);
        // Persist to blockstore for next reload
        if (helia.blockstore.put) {
          Promise.resolve(helia.blockstore.put(cid, block)).catch(
            (err: unknown) => log.warn("blockstore.put failed:", err),
          );
        }
      }
      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(node, readKey);
      const result: Record<string, Y.Doc> = {};
      for (const [ns, bytes] of Object.entries(plaintext)) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        result[ns] = doc;
      }
      decodedVersions.set(cidStr, result);
      return result;
    },

    getBlock(cidStr) {
      return blocks.get(cidStr);
    },

    putBlock(cidStr, block) {
      if (block.length > 0) {
        blocks.set(cidStr, block);
      }
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
