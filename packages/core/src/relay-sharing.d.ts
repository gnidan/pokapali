import type { Awareness } from "y-protocols/awareness";
import type { RoomDiscovery } from "./peer-discovery.js";
export interface RelaySharingOptions {
    awareness: Awareness;
    roomDiscovery: RoomDiscovery;
}
export interface RelaySharing {
    destroy(): void;
}
export declare function createRelaySharing(options: RelaySharingOptions): RelaySharing;
//# sourceMappingURL=relay-sharing.d.ts.map