import type { PubSubLike } from "@pokapali/sync";
import type { Helia } from "helia";
export declare const NODE_CAPS_TOPIC = "pokapali._node-caps._p2p._pubsub";
export interface KnownNode {
    peerId: string;
    roles: string[];
    lastSeenAt: number;
    connected: boolean;
}
export interface NodeRegistry {
    /** All known non-stale nodes. */
    readonly nodes: ReadonlyMap<string, KnownNode>;
    destroy(): void;
}
export declare function createNodeRegistry(pubsub: PubSubLike, getHelia: () => Helia): NodeRegistry;
export declare function acquireNodeRegistry(pubsub: PubSubLike, getHelia: () => Helia): NodeRegistry;
export declare function getNodeRegistry(): NodeRegistry | null;
export declare function _resetNodeRegistry(): void;
//# sourceMappingURL=node-registry.d.ts.map