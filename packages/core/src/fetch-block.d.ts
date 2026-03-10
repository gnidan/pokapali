import { CID } from "multiformats/cid";
export interface FetchBlockOptions {
    retries?: number;
    baseMs?: number;
    timeoutMs?: number;
}
export interface BlockGetter {
    blockstore: {
        get(cid: CID, opts?: {
            signal?: AbortSignal;
        }): Promise<Uint8Array> | Uint8Array;
        put?(cid: CID, block: Uint8Array): Promise<CID> | CID | void;
    };
}
export declare function fetchBlock(helia: BlockGetter, cid: CID, options?: FetchBlockOptions): Promise<Uint8Array>;
//# sourceMappingURL=fetch-block.d.ts.map