import { describe, it, expect, beforeEach, vi, } from "vitest";
import { loadCachedRelays, upsertCachedRelay, removeCachedRelay, migrateOldCache, _resetMigrated, CACHE_KEY, RELAY_CACHE_MAX_AGE_MS, } from "./relay-cache.js";
function makeStorage() {
    const store = new Map();
    return {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => {
            store.set(k, v);
        },
        removeItem: (k) => { store.delete(k); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (i) => [...store.keys()][i] ?? null,
    };
}
describe("relay-cache", () => {
    let storage;
    beforeEach(() => {
        storage = makeStorage();
        vi.stubGlobal("localStorage", storage);
        _resetMigrated();
    });
    describe("loadCachedRelays", () => {
        it("returns [] with no localStorage data", () => {
            expect(loadCachedRelays()).toEqual([]);
        });
        it("filters entries older than 48h", () => {
            const old = Date.now() - RELAY_CACHE_MAX_AGE_MS
                - 1000;
            const fresh = Date.now() - 1000;
            storage.setItem(CACHE_KEY, JSON.stringify([
                {
                    peerId: "old-peer",
                    addrs: ["/ip4/1.2.3.4/tcp/4001/ws"],
                    lastSeen: old,
                },
                {
                    peerId: "fresh-peer",
                    addrs: ["/ip4/5.6.7.8/tcp/4001/ws"],
                    lastSeen: fresh,
                },
            ]));
            const result = loadCachedRelays();
            expect(result).toHaveLength(1);
            expect(result[0].peerId).toBe("fresh-peer");
        });
        it("handles corrupted JSON", () => {
            storage.setItem(CACHE_KEY, "not json{{{");
            expect(loadCachedRelays()).toEqual([]);
        });
    });
    describe("migrateOldCache", () => {
        it("copies first old key to new key", () => {
            storage.setItem("pokapali:relays:app1", JSON.stringify([{
                    peerId: "p1",
                    addrs: [],
                    lastSeen: Date.now(),
                }]));
            migrateOldCache();
            const data = storage.getItem(CACHE_KEY);
            expect(data).not.toBeNull();
            expect(JSON.parse(data)[0].peerId).toBe("p1");
            // Old key removed
            expect(storage.getItem("pokapali:relays:app1")).toBeNull();
        });
        it("skips if new key already exists", () => {
            storage.setItem(CACHE_KEY, JSON.stringify([{
                    peerId: "existing",
                    addrs: [],
                    lastSeen: Date.now(),
                }]));
            storage.setItem("pokapali:relays:old", JSON.stringify([{
                    peerId: "old",
                    addrs: [],
                    lastSeen: Date.now(),
                }]));
            migrateOldCache();
            const data = JSON.parse(storage.getItem(CACHE_KEY));
            expect(data[0].peerId).toBe("existing");
        });
        it("handles localStorage errors", () => {
            const broken = {
                ...storage,
                getItem: () => {
                    throw new Error("denied");
                },
            };
            vi.stubGlobal("localStorage", broken);
            // Should not throw
            expect(() => migrateOldCache()).not.toThrow();
        });
    });
    describe("upsertCachedRelay", () => {
        it("updates existing entry's lastSeen", () => {
            const oldTime = Date.now() - 60_000;
            storage.setItem(CACHE_KEY, JSON.stringify([{
                    peerId: "p1",
                    addrs: ["/old"],
                    lastSeen: oldTime,
                }]));
            upsertCachedRelay("p1", ["/new"]);
            const data = JSON.parse(storage.getItem(CACHE_KEY));
            expect(data).toHaveLength(1);
            expect(data[0].addrs).toEqual(["/new"]);
            expect(data[0].lastSeen).toBeGreaterThan(oldTime);
        });
    });
    describe("removeCachedRelay", () => {
        it("no-ops for unknown peerId", () => {
            storage.setItem(CACHE_KEY, JSON.stringify([{
                    peerId: "p1",
                    addrs: [],
                    lastSeen: Date.now(),
                }]));
            removeCachedRelay("unknown");
            const data = JSON.parse(storage.getItem(CACHE_KEY));
            expect(data).toHaveLength(1);
            expect(data[0].peerId).toBe("p1");
        });
    });
});
//# sourceMappingURL=relay-cache.test.js.map