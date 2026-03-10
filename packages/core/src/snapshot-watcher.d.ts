import type { CID } from "multiformats/cid";
import type { PubSubLike } from "@pokapali/sync";
import type { Helia } from "helia";
export type SnapshotFetchState = {
    status: "idle";
} | {
    status: "resolving";
    startedAt: number;
} | {
    status: "fetching";
    cid: string;
    startedAt: number;
} | {
    status: "retrying";
    cid: string;
    attempt: number;
    nextRetryAt: number;
} | {
    status: "failed";
    cid: string;
    error: string;
};
export type GossipActivity = "inactive" | "subscribed" | "receiving";
export interface SnapshotWatcherOptions {
    appId: string;
    ipnsName: string;
    pubsub: PubSubLike;
    getHelia: () => Helia;
    isWriter: boolean;
    ipnsPublicKeyBytes?: Uint8Array;
    onSnapshot: (cid: CID) => Promise<void>;
    onFetchStateChange?: (state: SnapshotFetchState) => void;
    onAck?: (peerId: string) => void;
    onGossipActivityChange?: (activity: GossipActivity) => void;
    performInitialResolve?: boolean;
}
export interface SnapshotWatcher {
    startReannounce(getCid: () => CID | null, getBlock: (cidStr: string) => Uint8Array | undefined, getSeq?: () => number | null): void;
    /** Trigger an immediate re-announce (e.g. on new
     *  relay connect). No-op if startReannounce hasn't
     *  been called or no snapshot exists yet. */
    reannounceNow(): void;
    /** Track a newly pushed CID for ack collection. */
    trackCidForAcks(cid: string): void;
    readonly latestAnnouncedSeq: number;
    readonly fetchState: SnapshotFetchState;
    readonly hasAppliedSnapshot: boolean;
    /** Peer IDs of pinners that acked the latest CID. */
    readonly ackedBy: ReadonlySet<string>;
    /** Latest guarantee-until timestamp across all
     *  pinners for the current CID, or null if none. */
    readonly guaranteeUntil: number | null;
    /** Latest retain-until timestamp across all
     *  pinners for the current CID, or null if none. */
    readonly retainUntil: number | null;
    /** GossipSub liveness: inactive → subscribed →
     *  receiving. Decays after 60s without messages. */
    readonly gossipActivity: GossipActivity;
    destroy(): void;
}
export declare function createSnapshotWatcher(options: SnapshotWatcherOptions): SnapshotWatcher;
//# sourceMappingURL=snapshot-watcher.d.ts.map