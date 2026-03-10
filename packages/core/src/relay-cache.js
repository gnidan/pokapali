// --- Relay cache (localStorage) ---
function hasLocalStorage() {
    return typeof globalThis.localStorage
        !== "undefined";
}
export const CACHE_KEY = "pokapali:relays";
export const RELAY_CACHE_MAX_AGE_MS = 48 * 60 * 60_000; // 48h
// Migrate old per-app cache entries to the new
// network-wide key. Runs once on first load.
let migrated = false;
export function migrateOldCache() {
    if (migrated || !hasLocalStorage())
        return;
    migrated = true;
    try {
        // Already have entries — no migration needed
        if (localStorage.getItem(CACHE_KEY))
            return;
        // Scan for old per-app keys
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key?.startsWith("pokapali:relays:"))
                continue;
            const raw = localStorage.getItem(key);
            if (!raw)
                continue;
            // Copy first match to new key, remove old
            localStorage.setItem(CACHE_KEY, raw);
            localStorage.removeItem(key);
            return;
        }
    }
    catch {
        // ignore
    }
}
/**
 * Reset migration flag. For testing only.
 */
export function _resetMigrated() {
    migrated = false;
}
export function loadCachedRelays() {
    if (!hasLocalStorage())
        return [];
    migrateOldCache();
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw)
            return [];
        const entries = JSON.parse(raw);
        const now = Date.now();
        // Drop entries older than max age
        return entries.filter((e) => now - e.lastSeen < RELAY_CACHE_MAX_AGE_MS);
    }
    catch {
        return [];
    }
}
function saveCachedRelays(relays) {
    if (!hasLocalStorage())
        return;
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(relays));
    }
    catch {
        // quota exceeded, etc.
    }
}
export function removeCachedRelay(peerId) {
    const relays = loadCachedRelays();
    const filtered = relays.filter((r) => r.peerId !== peerId);
    if (filtered.length !== relays.length) {
        saveCachedRelays(filtered);
    }
}
export function upsertCachedRelay(peerId, addrs) {
    const relays = loadCachedRelays();
    const existing = relays.find((r) => r.peerId === peerId);
    if (existing) {
        existing.addrs = addrs;
        existing.lastSeen = Date.now();
    }
    else {
        relays.push({
            peerId,
            addrs,
            lastSeen: Date.now(),
        });
    }
    saveCachedRelays(relays);
}
//# sourceMappingURL=relay-cache.js.map