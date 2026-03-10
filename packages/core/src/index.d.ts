import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { Capability, CapabilityGrant } from "@pokapali/capability";
import type { SyncOptions } from "@pokapali/sync";
import { CID } from "multiformats/cid";
import type { SnapshotFetchState } from "./snapshot-watcher.js";
export interface CollabLibOptions {
    appId?: string;
    namespaces: string[];
    primaryNamespace?: string;
    base: string;
    signalingUrls?: string[];
    bootstrapPeers?: string[];
    peerOpts?: SyncOptions["peerOpts"];
}
export type DocStatus = "connecting" | "synced" | "receiving" | "offline";
export type SaveState = "saved" | "unpublished" | "saving" | "dirty";
export type { GossipActivity, } from "./snapshot-watcher.js";
export type { SnapshotFetchState } from "./snapshot-watcher.js";
export interface RotateResult {
    newDoc: CollabDoc;
    forwardingRecord: Uint8Array;
}
export type DocRole = "admin" | "writer" | "reader";
export interface NodeInfo {
    peerId: string;
    short: string;
    connected: boolean;
    roles: string[];
    /** True after a caps broadcast confirms roles. */
    rolesConfirmed: boolean;
    ackedCurrentCid: boolean;
    lastSeenAt: number;
}
export interface GossipSubDiagnostic {
    peers: number;
    topics: number;
    meshPeers: number;
}
export interface DiagnosticsInfo {
    ipfsPeers: number;
    nodes: NodeInfo[];
    editors: number;
    gossipsub: GossipSubDiagnostic;
    clockSum: number;
    maxPeerClockSum: number;
    latestAnnouncedSeq: number;
    ipnsSeq: number | null;
    fetchState: SnapshotFetchState;
    hasAppliedSnapshot: boolean;
    /** Peer IDs of pinners that acked the latest CID. */
    ackedBy: string[];
    /** Latest guarantee-until timestamp across all
     *  pinners for the current CID, or null if none. */
    guaranteeUntil: number | null;
    /** Latest retain-until timestamp across all
     *  pinners for the current CID, or null if none. */
    retainUntil: number | null;
}
export interface CollabDoc {
    subdoc(ns: string): Y.Doc;
    readonly provider: {
        readonly awareness: Awareness;
    };
    readonly awareness: Awareness;
    readonly capability: Capability;
    readonly adminUrl: string | null;
    readonly writeUrl: string | null;
    readonly readUrl: string;
    /** Best available URL (admin > write > read). */
    readonly bestUrl: string;
    /** Role derived from capability. */
    readonly role: DocRole;
    inviteUrl(grant: CapabilityGrant): Promise<string>;
    readonly status: DocStatus;
    /** Persistence state (dirty → saving → saved). */
    readonly saveState: SaveState;
    /** Peer IDs of relays discovered for this app. */
    readonly relayPeerIds: ReadonlySet<string>;
    /** Sum of all Y.Doc state vector clocks. */
    readonly clockSum: number;
    /** Last IPNS sequence number used for publish. */
    readonly ipnsSeq: number | null;
    /** Highest seq seen in GossipSub announcements. */
    readonly latestAnnouncedSeq: number;
    /** Current snapshot fetch lifecycle state. */
    readonly snapshotFetchState: SnapshotFetchState;
    /** True after first remote snapshot applied. */
    readonly hasAppliedSnapshot: boolean;
    /** Peer IDs of pinners that acked the latest CID. */
    readonly ackedBy: ReadonlySet<string>;
    /** Latest guarantee-until timestamp across all
     *  pinners for the current CID, or null if none. */
    readonly guaranteeUntil: number | null;
    /** Latest retain-until timestamp across all
     *  pinners for the current CID, or null if none. */
    readonly retainUntil: number | null;
    /**
     * Resolves when the document has meaningful state:
     * either a remote snapshot was applied, initial IPNS
     * resolution found nothing to load, or the document
     * was locally created (resolves immediately).
     */
    whenReady(): Promise<void>;
    pushSnapshot(): Promise<void>;
    rotate(): Promise<RotateResult>;
    on(event: "status", cb: (status: DocStatus) => void): void;
    on(event: "snapshot-recommended", cb: () => void): void;
    on(event: "snapshot-applied", cb: () => void): void;
    on(event: "fetch-state", cb: (state: SnapshotFetchState) => void): void;
    on(event: "ack", cb: (peerId: string) => void): void;
    on(event: "save-state", cb: (state: SaveState) => void): void;
    off(event: "status", cb: (status: DocStatus) => void): void;
    off(event: "snapshot-recommended", cb: () => void): void;
    off(event: "snapshot-applied", cb: () => void): void;
    off(event: "fetch-state", cb: (state: SnapshotFetchState) => void): void;
    off(event: "ack", cb: (peerId: string) => void): void;
    off(event: "save-state", cb: (state: SaveState) => void): void;
    diagnostics(): DiagnosticsInfo;
    history(): Promise<Array<{
        cid: CID;
        seq: number;
        ts: number;
    }>>;
    loadVersion(cid: CID): Promise<Record<string, Y.Doc>>;
    destroy(): void;
}
export interface CollabLib {
    create(): Promise<CollabDoc>;
    open(url: string): Promise<CollabDoc>;
    /** Check if a URL matches this app's doc format. */
    isDocUrl(url: string): boolean;
    docIdFromUrl(url: string): string;
}
export declare function createCollabLib(options: CollabLibOptions): CollabLib;
export { encodeForwardingRecord, decodeForwardingRecord, verifyForwardingRecord, clearForwardingStore, } from "./forwarding.js";
export type { ForwardingRecord, } from "./forwarding.js";
export { getHelia } from "./helia.js";
export { createAutoSaver, } from "./auto-save.js";
export type { AutoSaveOptions, } from "./auto-save.js";
export { truncateUrl, docIdFromUrl } from "./url-utils.js";
export { NODE_CAPS_TOPIC, _resetNodeRegistry, } from "./node-registry.js";
export type { KnownNode, NodeRegistry, } from "./node-registry.js";
//# sourceMappingURL=index.d.ts.map