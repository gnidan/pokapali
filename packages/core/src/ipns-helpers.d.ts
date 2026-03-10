import type { Helia } from "helia";
import { type CID } from "multiformats/cid";
/**
 * Publish an IPNS record mapping ipnsKeyBytes → cid.
 *
 * Uses the caller-provided `clockSum` (derived from the
 * Y.Doc state vector) as the IPNS sequence number. This
 * makes the seq deterministic: same doc state → same
 * seq, so multiple browsers publishing the same snapshot
 * produce identical records (no race). A browser with
 * more edits naturally gets a higher seq.
 *
 * Serialized per key within a tab via publish queue.
 *
 * Publishes directly via delegated HTTP, bypassing
 * Helia's composed routing (DHT hangs in browsers).
 */
export declare function publishIPNS(helia: Helia, ipnsKeyBytes: Uint8Array, cid: CID, clockSum: number): Promise<void>;
export declare function resolveIPNS(helia: Helia, publicKeyBytes: Uint8Array): Promise<CID | null>;
/**
 * Poll resolveIPNS at an interval; call onUpdate when
 * the resolved CID changes.
 *
 * @returns a stop function to cancel polling
 */
export interface WatchIPNSOptions {
    intervalMs?: number;
    onPollStart?: () => void;
}
export declare function watchIPNS(helia: Helia, publicKeyBytes: Uint8Array, onUpdate: (cid: CID) => void, intervalOrOpts?: number | WatchIPNSOptions): () => void;
//# sourceMappingURL=ipns-helpers.d.ts.map