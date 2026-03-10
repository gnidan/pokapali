import type { Helia } from "helia";
import type { Libp2p, PubSub } from "@libp2p/interface";
export interface HeliaOptions {
    bootstrapPeers?: string[];
}
interface HeliaWithPubsub extends Helia<Libp2p<{
    pubsub: PubSub;
}>> {
}
export declare function acquireHelia(options?: HeliaOptions): Promise<HeliaWithPubsub>;
export declare function releaseHelia(): Promise<void>;
export declare function getHeliaPubsub(): PubSub;
export declare function getHelia(): Helia;
/**
 * Reset internal state. For testing only.
 */
export declare function _resetHeliaState(): void;
export {};
//# sourceMappingURL=helia.d.ts.map