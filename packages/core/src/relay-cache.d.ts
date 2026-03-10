export interface CachedRelay {
    peerId: string;
    addrs: string[];
    lastSeen: number;
}
export declare const CACHE_KEY = "pokapali:relays";
export declare const RELAY_CACHE_MAX_AGE_MS: number;
export declare function migrateOldCache(): void;
/**
 * Reset migration flag. For testing only.
 */
export declare function _resetMigrated(): void;
export declare function loadCachedRelays(): CachedRelay[];
export declare function removeCachedRelay(peerId: string): void;
export declare function upsertCachedRelay(peerId: string, addrs: string[]): void;
//# sourceMappingURL=relay-cache.d.ts.map