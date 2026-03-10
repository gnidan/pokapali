import * as Y from "yjs";
import type { CID } from "multiformats/cid";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { BlockGetter } from "./fetch-block.js";
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
    push(plaintext: Record<string, Uint8Array>, readKey: CryptoKey, signingKey: Ed25519KeyPair, clockSum: number): Promise<PushResult>;
    applyRemote(cid: CID, readKey: CryptoKey, onApply: (plaintext: Record<string, Uint8Array>) => void): Promise<boolean>;
    history(): Promise<Array<{
        cid: CID;
        seq: number;
        ts: number;
    }>>;
    loadVersion(cid: CID, readKey: CryptoKey): Promise<Record<string, Y.Doc>>;
    getBlock(cidStr: string): Uint8Array | undefined;
    putBlock(cidStr: string, block: Uint8Array): void;
    readonly prev: CID | null;
    readonly seq: number;
    readonly lastIpnsSeq: number | null;
    setLastIpnsSeq(seq: number): void;
}
export declare function createSnapshotLifecycle(options: SnapshotLifecycleOptions): SnapshotLifecycle;
//# sourceMappingURL=snapshot-lifecycle.d.ts.map