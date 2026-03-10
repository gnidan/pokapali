import type { Helia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
export declare function extractWssAddrs(pid: string, rawAddrs: string[], isSecureContext: boolean): ReturnType<typeof multiaddr>[];
export interface RelayEntry {
    peerId: string;
    addrs: string[];
}
export interface RoomDiscovery {
    /** Peer IDs of relays discovered for this app. */
    readonly relayPeerIds: ReadonlySet<string>;
    /** Current known relay entries for sharing. */
    relayEntries(): RelayEntry[];
    /** Try dialing relays learned from another peer. */
    addExternalRelays(entries: RelayEntry[]): void;
    stop(): void;
}
/**
 * Discover relay nodes by looking up a network-wide CID
 * on the DHT. All relays provide this CID; browsers find
 * them via delegated routing regardless of app.
 * Once connected, pubsub-peer-discovery (configured in
 * helia.ts) handles browser-to-browser discovery.
 *
 * On startup, tries cached relay addresses from
 * localStorage first (fast direct dial), then runs
 * DHT discovery in parallel to refresh the cache.
 */
export declare function startRoomDiscovery(helia: Helia, _appId?: string): RoomDiscovery;
//# sourceMappingURL=peer-discovery.d.ts.map