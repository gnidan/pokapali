import * as Y from "yjs";
import { inferCapability, narrowCapability, buildUrl, parseUrl, } from "@pokapali/capability";
import { generateAdminSecret, deriveDocKeys, ed25519KeyPairFromSeed, hexToBytes, bytesToHex, } from "@pokapali/crypto";
import { createSubdocManager } from "@pokapali/subdocs";
import { setupNamespaceRooms, setupAwarenessRoom, } from "@pokapali/sync";
import { createForwardingRecord, encodeForwardingRecord, storeForwardingRecord, lookupForwardingRecord, decodeForwardingRecord, verifyForwardingRecord, } from "./forwarding.js";
import { acquireHelia, releaseHelia, getHeliaPubsub, getHelia, } from "./helia.js";
import { publishIPNS, } from "./ipns-helpers.js";
import { announceSnapshot, } from "./announce.js";
import { startRoomDiscovery, } from "./peer-discovery.js";
import { createSnapshotLifecycle, } from "./snapshot-lifecycle.js";
import { createSnapshotWatcher, } from "./snapshot-watcher.js";
import { createRelaySharing, } from "./relay-sharing.js";
import { acquireNodeRegistry, getNodeRegistry, } from "./node-registry.js";
import { docIdFromUrl } from "./url-utils.js";
import { createLogger } from "@pokapali/log";
const log = createLogger("core");
const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];
function computeStatus(syncStatus, awarenessConnected, gossipActivity) {
    if (syncStatus === "connected")
        return "synced";
    if (syncStatus === "connecting")
        return "connecting";
    if (awarenessConnected)
        return "receiving";
    if (gossipActivity === "receiving")
        return "receiving";
    if (gossipActivity === "subscribed") {
        return "connecting";
    }
    return "offline";
}
function computeSaveState(isDirty, isSaving) {
    if (isSaving)
        return "saving";
    if (isDirty)
        return "dirty";
    return "saved";
}
function createDoc(params) {
    const { subdocManager, syncManager, awarenessRoom, cap, keys, ipnsName, origin, channels, signingKey, readKey, } = params;
    let destroyed = false;
    let readyResolved = false;
    let resolveReady = null;
    const readyPromise = new Promise((resolve) => {
        resolveReady = resolve;
    });
    function markReady() {
        if (!readyResolved) {
            readyResolved = true;
            resolveReady?.();
        }
    }
    if (!params.performInitialResolve) {
        markReady();
    }
    const snapshotLC = createSnapshotLifecycle({
        getHelia: () => getHelia(),
    });
    const listeners = new Map();
    function emit(event, ...args) {
        const cbs = listeners.get(event);
        if (cbs) {
            for (const cb of cbs)
                cb(...args);
        }
    }
    // --- Status tracking (3 inputs) ---
    let gossipActivity = "inactive";
    let isSaving = false;
    let lastStatus = computeStatus(syncManager.status, awarenessRoom.connected, gossipActivity);
    let lastSaveState = computeSaveState(subdocManager.isDirty, isSaving);
    function checkStatus() {
        const next = computeStatus(syncManager.status, awarenessRoom.connected, gossipActivity);
        if (next !== lastStatus) {
            lastStatus = next;
            emit("status", next);
        }
    }
    function checkSaveState() {
        const next = computeSaveState(subdocManager.isDirty, isSaving);
        if (next !== lastSaveState) {
            lastSaveState = next;
            emit("save", next);
        }
    }
    function computeClockSum() {
        let sum = 0;
        for (const ns of channels) {
            const sv = Y.encodeStateVector(subdocManager.subdoc(ns));
            const decoded = Y.decodeStateVector(sv);
            for (const clock of decoded.values()) {
                sum += clock;
            }
        }
        return sum;
    }
    subdocManager.on("dirty", () => {
        checkSaveState();
        emit("publish-needed");
        awarenessRoom.awareness.setLocalStateField("clockSum", computeClockSum());
    });
    syncManager.onStatusChange(() => checkStatus());
    awarenessRoom.onStatusChange(() => checkStatus());
    // If the subdoc is already dirty (e.g. _meta was
    // populated before we registered), fire the event
    // so the auto-save debounce starts.
    if (subdocManager.isDirty) {
        // Defer to next microtask so callers can attach
        // event listeners first.
        queueMicrotask(() => {
            checkSaveState();
            emit("publish-needed");
        });
    }
    // Share relay info with WebRTC peers via awareness.
    let relaySharing = null;
    let cleanupRelayConnect = null;
    if (params.roomDiscovery) {
        relaySharing = createRelaySharing({
            awareness: awarenessRoom.awareness,
            roomDiscovery: params.roomDiscovery,
        });
    }
    // Snapshot watching: announce subscription, IPNS
    // polling, re-announce for writers, initial resolve.
    let snapshotWatcher = null;
    if (readKey && params.pubsub && params.appId) {
        const rk = readKey;
        log.debug("announce setup: pubsub=" +
            !!params.pubsub +
            " appId=" + params.appId);
        snapshotWatcher = createSnapshotWatcher({
            appId: params.appId,
            ipnsName,
            pubsub: params.pubsub,
            getHelia: () => getHelia(),
            isWriter: cap.canPushSnapshots,
            ipnsPublicKeyBytes: hexToBytes(ipnsName),
            performInitialResolve: params.performInitialResolve,
            onAck: (peerId) => {
                emit("ack", peerId);
            },
            onGossipActivityChange: (activity) => {
                gossipActivity = activity;
                checkStatus();
            },
            onFetchStateChange: (state) => {
                emit("loading", state);
                // If we return to idle or hit permanent failure
                // without ever applying a snapshot, the document
                // is as ready as it gets — mount the editor so
                // the user sees status indicators instead of a
                // blank loading screen.
                if ((state.status === "idle" ||
                    state.status === "failed") &&
                    !readyResolved &&
                    !snapshotWatcher?.hasAppliedSnapshot) {
                    markReady();
                }
            },
            onSnapshot: async (cid) => {
                const applied = await snapshotLC.applyRemote(cid, rk, (plaintext) => subdocManager.applySnapshot(plaintext));
                if (applied) {
                    snapshotLC.setLastIpnsSeq(computeClockSum());
                    emit("snapshot");
                    markReady();
                }
            },
        });
        // Periodically re-announce the latest snapshot
        // so pinners and new peers discover it even if
        // the original writer is offline.
        snapshotWatcher.startReannounce(() => snapshotLC.prev, (cidStr) => snapshotLC.getBlock(cidStr), () => snapshotLC.lastIpnsSeq);
        // Immediately re-announce when a new relay
        // connects so its pinner discovers the latest
        // snapshot without waiting for the interval.
        if (params.roomDiscovery) {
            const rd = params.roomDiscovery;
            const sw = snapshotWatcher;
            const connectHandler = (evt) => {
                const pid = evt.detail?.toString?.() ?? "";
                if (rd.relayPeerIds.has(pid)) {
                    sw.reannounceNow();
                }
            };
            const helia = getHelia();
            helia.libp2p.addEventListener("peer:connect", connectHandler);
            cleanupRelayConnect = () => {
                helia.libp2p.removeEventListener("peer:connect", connectHandler);
            };
        }
    }
    function teardown() {
        destroyed = true;
        cleanupRelayConnect?.();
        relaySharing?.destroy();
        snapshotWatcher?.destroy();
        params.roomDiscovery?.stop();
        syncManager.destroy();
        awarenessRoom.destroy();
        subdocManager.destroy();
        releaseHelia();
    }
    function assertNotDestroyed() {
        if (destroyed) {
            throw new Error("Doc destroyed");
        }
    }
    const providerObj = {
        get awareness() {
            return awarenessRoom.awareness;
        },
    };
    return {
        channel(name) {
            assertNotDestroyed();
            try {
                return subdocManager.subdoc(name);
            }
            catch {
                throw new Error(`Unknown channel "${name}". ` +
                    "Configured: " +
                    channels.join(", "));
            }
        },
        get provider() {
            return providerObj;
        },
        get awareness() {
            return awarenessRoom.awareness;
        },
        get capability() {
            return cap;
        },
        get urls() {
            return {
                admin: params.adminUrl,
                write: params.writeUrl,
                read: params.readUrl,
                get best() {
                    return params.adminUrl
                        ?? params.writeUrl
                        ?? params.readUrl;
                },
            };
        },
        get role() {
            if (cap.isAdmin)
                return "admin";
            if (cap.namespaces.size > 0)
                return "writer";
            return "reader";
        },
        async invite(grant) {
            assertNotDestroyed();
            if (grant.namespaces) {
                for (const ns of grant.namespaces) {
                    if (!cap.namespaces.has(ns)) {
                        throw new Error(`Cannot grant "${ns}" ` +
                            "— not in own capability");
                    }
                }
            }
            if (grant.canPushSnapshots &&
                !cap.canPushSnapshots) {
                throw new Error("Cannot grant canPushSnapshots " +
                    "— not in own capability");
            }
            const narrowed = narrowCapability(keys, grant);
            return buildUrl(origin, ipnsName, narrowed);
        },
        get status() {
            return computeStatus(syncManager.status, awarenessRoom.connected, gossipActivity);
        },
        get saveState() {
            return computeSaveState(subdocManager.isDirty, isSaving);
        },
        get relays() {
            return params.roomDiscovery?.relayPeerIds
                ?? new Set();
        },
        get clockSum() {
            return computeClockSum();
        },
        get ipnsSeq() {
            return snapshotLC.lastIpnsSeq;
        },
        get latestAnnouncedSeq() {
            return snapshotWatcher?.latestAnnouncedSeq ?? 0;
        },
        get loadingState() {
            return snapshotWatcher?.fetchState
                ?? { status: "idle" };
        },
        get hasAppliedSnapshot() {
            return snapshotWatcher
                ?.hasAppliedSnapshot ?? false;
        },
        get ackedBy() {
            return snapshotWatcher?.ackedBy
                ?? new Set();
        },
        get guaranteeUntil() {
            return snapshotWatcher?.guaranteeUntil
                ?? null;
        },
        get retainUntil() {
            return snapshotWatcher?.retainUntil
                ?? null;
        },
        ready() {
            return readyPromise;
        },
        async publish() {
            assertNotDestroyed();
            if (!cap.canPushSnapshots ||
                !signingKey ||
                !readKey) {
                return;
            }
            isSaving = true;
            checkSaveState();
            const plaintext = subdocManager.encodeAll();
            const clockSum = this.clockSum;
            const { cid, block } = await snapshotLC.push(plaintext, readKey, signingKey, clockSum);
            isSaving = false;
            checkSaveState();
            emit("snapshot");
            // Reset ack tracking synchronously so the UI
            // clears immediately and early acks aren't
            // dropped.
            snapshotWatcher?.trackCidForAcks(cid.toString());
            // Persist to Helia + publish IPNS + announce.
            // Fire-and-forget: don't block the UI on slow
            // DHT operations.
            const cidShort = cid.toString().slice(0, 16);
            log.info("publish: cid=" +
                cidShort + "... clockSum=" + clockSum);
            (async () => {
                const helia = getHelia();
                log.debug("blockstore.put...", cidShort + "...");
                await Promise.resolve(helia.blockstore.put(cid, block));
                log.debug("blockstore.put done,"
                    + " publishing IPNS...");
                await publishIPNS(helia, keys.ipnsKeyBytes, cid, clockSum);
                log.debug("IPNS published, announcing...");
                if (params.appId && params.pubsub) {
                    await announceSnapshot(params.pubsub, params.appId, ipnsName, cid.toString(), clockSum, block);
                    log.debug("announce sent");
                }
            })().catch((err) => {
                log.error("IPNS publish/announce failed:", err);
            });
        },
        async rotate() {
            assertNotDestroyed();
            if (!cap.isAdmin || !keys.rotationKey) {
                throw new Error("Only admins can rotate" +
                    " (requires rotationKey)");
            }
            const newAdminSecret = generateAdminSecret();
            const newDocKeys = await deriveDocKeys(newAdminSecret, params.appId, channels);
            const newSigningKey = await ed25519KeyPairFromSeed(newDocKeys.ipnsKeyBytes);
            const newIpnsName = bytesToHex(newSigningKey.publicKey);
            // Copy current state to new subdoc manager
            const newSubdocManager = createSubdocManager(newIpnsName, channels, {
                primaryNamespace: params.primaryChannel,
            });
            const snapshot = subdocManager.encodeAll();
            newSubdocManager.applySnapshot(snapshot);
            const rotateSyncOpts = {
                ...params.syncOpts,
                ...(params.pubsub
                    ? { pubsub: params.pubsub }
                    : {}),
            };
            const newSyncManager = setupNamespaceRooms(newIpnsName, newSubdocManager, newDocKeys.namespaceKeys, params.signalingUrls, rotateSyncOpts);
            const newAwarenessRoom = setupAwarenessRoom(newIpnsName, newDocKeys.awarenessRoomPassword, params.signalingUrls, rotateSyncOpts);
            const newKeys = {
                readKey: newDocKeys.readKey,
                ipnsKeyBytes: newDocKeys.ipnsKeyBytes,
                rotationKey: newDocKeys.rotationKey,
                awarenessRoomPassword: newDocKeys.awarenessRoomPassword,
                namespaceKeys: newDocKeys.namespaceKeys,
            };
            const newAdminUrl = await buildUrl(origin, newIpnsName, newKeys);
            const newWriteUrl = await buildUrl(origin, newIpnsName, narrowCapability(newKeys, {
                namespaces: [...channels],
                canPushSnapshots: true,
            }));
            const newReadUrl = await buildUrl(origin, newIpnsName, narrowCapability(newKeys, {
                namespaces: [],
            }));
            const newCap = inferCapability(newKeys, channels);
            // Populate _meta on new doc
            const newMeta = newSubdocManager.metaDoc;
            const canPush = newMeta.getArray("canPushSnapshots");
            canPush.push([newSigningKey.publicKey]);
            const authorized = newMeta.getMap("authorized");
            for (const [ns, key] of Object.entries(newDocKeys.namespaceKeys)) {
                const arr = new Y.Array();
                authorized.set(ns, arr);
                arr.push([key]);
            }
            let newRoomDiscovery;
            try {
                newRoomDiscovery = startRoomDiscovery(getHelia(), params.appId);
            }
            catch {
                // Helia may not be available
            }
            const newDoc = createDoc({
                subdocManager: newSubdocManager,
                syncManager: newSyncManager,
                awarenessRoom: newAwarenessRoom,
                cap: newCap,
                keys: newKeys,
                ipnsName: newIpnsName,
                origin,
                channels,
                adminUrl: newAdminUrl,
                writeUrl: newWriteUrl,
                readUrl: newReadUrl,
                signingKey: newSigningKey,
                readKey: newDocKeys.readKey,
                appId: params.appId,
                primaryChannel: params.primaryChannel,
                signalingUrls: params.signalingUrls,
                syncOpts: params.syncOpts,
                pubsub: params.pubsub,
                roomDiscovery: newRoomDiscovery,
            });
            // Create and store forwarding record
            const fwdRecord = await createForwardingRecord(ipnsName, newIpnsName, newReadUrl, keys.rotationKey);
            const encoded = encodeForwardingRecord(fwdRecord);
            storeForwardingRecord(ipnsName, encoded);
            // Destroy old doc
            teardown();
            return {
                newDoc,
                forwardingRecord: encoded,
            };
        },
        on(event, 
        // eslint-disable-next-line
        cb) {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event).add(cb);
        },
        off(event, 
        // eslint-disable-next-line
        cb) {
            listeners.get(event)?.delete(cb);
        },
        diagnostics() {
            assertNotDestroyed();
            let ipfsPeers = 0;
            const nodeList = [];
            let gossipsub = {
                peers: 0,
                topics: 0,
                meshPeers: 0,
            };
            const ackedSet = snapshotWatcher?.ackedBy
                ?? new Set();
            try {
                const helia = getHelia();
                const libp2p = helia.libp2p;
                ipfsPeers = libp2p.getPeers().length;
                // Build node list from registry
                const registry = getNodeRegistry();
                const seenPids = new Set();
                if (registry) {
                    for (const node of registry.nodes
                        .values()) {
                        seenPids.add(node.peerId);
                        const acked = ackedSet.has(node.peerId);
                        // If peer acked, it's a pinner even
                        // if caps didn't include that role.
                        const roles = acked &&
                            !node.roles.includes("pinner")
                            ? [...node.roles, "pinner"]
                            : node.roles;
                        nodeList.push({
                            peerId: node.peerId,
                            short: node.peerId.slice(-8),
                            connected: node.connected,
                            roles,
                            rolesConfirmed: true,
                            ackedCurrentCid: acked,
                            lastSeenAt: node.lastSeenAt,
                        });
                    }
                }
                // Merge DHT-discovered relays not yet in
                // the registry (before caps broadcast).
                // Roles unknown until caps arrives.
                const dhtRelays = params.roomDiscovery?.relayPeerIds;
                if (dhtRelays) {
                    for (const pid of dhtRelays) {
                        if (seenPids.has(pid))
                            continue;
                        const conns = libp2p.getConnections();
                        const connected = conns.some((c) => c.remotePeer.toString() === pid);
                        const acked = ackedSet.has(pid);
                        nodeList.push({
                            peerId: pid,
                            short: pid.slice(-8),
                            connected,
                            roles: acked ? ["pinner"] : [],
                            rolesConfirmed: false,
                            ackedCurrentCid: acked,
                            lastSeenAt: 0,
                        });
                    }
                }
                try {
                    const pubsub = libp2p.services.pubsub;
                    const topics = pubsub.getTopics?.() ?? [];
                    const gsPeers = pubsub.getPeers?.() ?? [];
                    const mesh = pubsub.mesh;
                    let meshPeers = 0;
                    if (mesh) {
                        for (const set of mesh.values()) {
                            meshPeers += set.size;
                        }
                    }
                    gossipsub = {
                        peers: gsPeers.length,
                        topics: topics.length,
                        meshPeers,
                    };
                }
                catch { }
            }
            catch {
                // Helia not ready
            }
            let maxPeerClockSum = 0;
            let editors = 1;
            try {
                const states = awarenessRoom.awareness.getStates();
                editors = Math.max(1, states.size);
                for (const [, state] of states) {
                    const cs = state?.clockSum;
                    if (typeof cs === "number" &&
                        cs > maxPeerClockSum) {
                        maxPeerClockSum = cs;
                    }
                }
            }
            catch { }
            return {
                ipfsPeers,
                nodes: nodeList,
                editors,
                gossipsub,
                clockSum: computeClockSum(),
                maxPeerClockSum,
                latestAnnouncedSeq: snapshotWatcher?.latestAnnouncedSeq ?? 0,
                ipnsSeq: snapshotLC.lastIpnsSeq,
                loadingState: snapshotWatcher?.fetchState
                    ?? { status: "idle" },
                hasAppliedSnapshot: snapshotWatcher?.hasAppliedSnapshot
                    ?? false,
                ackedBy: [...ackedSet],
                guaranteeUntil: snapshotWatcher?.guaranteeUntil ?? null,
                retainUntil: snapshotWatcher?.retainUntil ?? null,
            };
        },
        async history() {
            assertNotDestroyed();
            return snapshotLC.history();
        },
        async loadVersion(cid) {
            assertNotDestroyed();
            if (!readKey) {
                throw new Error("No readKey available");
            }
            return snapshotLC.loadVersion(cid, readKey);
        },
        destroy() {
            if (destroyed)
                return;
            teardown();
        },
    };
}
export function pokapali(options) {
    const { channels, origin } = options;
    const appId = options.appId ?? "";
    const primaryChannel = options.primaryChannel ?? channels[0];
    const signalingUrls = options.signalingUrls ?? [];
    const bootstrapPeers = options.bootstrapPeers;
    return {
        async create() {
            await acquireHelia({ bootstrapPeers });
            try {
                const pubsub = getHeliaPubsub();
                acquireNodeRegistry(pubsub, () => getHelia());
                const userIce = options.rtc?.config?.iceServers;
                const syncOpts = {
                    peerOpts: {
                        config: {
                            iceServers: userIce ?? DEFAULT_ICE_SERVERS,
                        },
                    },
                    pubsub,
                };
                const adminSecret = generateAdminSecret();
                const docKeys = await deriveDocKeys(adminSecret, appId, channels);
                const signingKey = await ed25519KeyPairFromSeed(docKeys.ipnsKeyBytes);
                const ipnsName = bytesToHex(signingKey.publicKey);
                const subdocManager = createSubdocManager(ipnsName, channels, {
                    primaryNamespace: primaryChannel,
                });
                const syncManager = setupNamespaceRooms(ipnsName, subdocManager, docKeys.namespaceKeys, signalingUrls, syncOpts);
                const awarenessRoom = setupAwarenessRoom(ipnsName, docKeys.awarenessRoomPassword, signalingUrls, syncOpts);
                const roomDiscovery = startRoomDiscovery(getHelia(), appId);
                const fullKeys = {
                    readKey: docKeys.readKey,
                    ipnsKeyBytes: docKeys.ipnsKeyBytes,
                    rotationKey: docKeys.rotationKey,
                    awarenessRoomPassword: docKeys.awarenessRoomPassword,
                    namespaceKeys: docKeys.namespaceKeys,
                };
                const adminUrl = await buildUrl(origin, ipnsName, fullKeys);
                const writeUrl = await buildUrl(origin, ipnsName, narrowCapability(fullKeys, {
                    namespaces: [...channels],
                    canPushSnapshots: true,
                }));
                const readUrl = await buildUrl(origin, ipnsName, narrowCapability(fullKeys, {
                    namespaces: [],
                }));
                const cap = inferCapability(fullKeys, channels);
                // Populate _meta doc
                const meta = subdocManager.metaDoc;
                const canPush = meta.getArray("canPushSnapshots");
                canPush.push([signingKey.publicKey]);
                const authorized = meta.getMap("authorized");
                for (const [ns, key] of Object.entries(docKeys.namespaceKeys)) {
                    const arr = new Y.Array();
                    authorized.set(ns, arr);
                    arr.push([key]);
                }
                return createDoc({
                    subdocManager,
                    syncManager,
                    awarenessRoom,
                    cap,
                    keys: fullKeys,
                    ipnsName,
                    origin,
                    channels,
                    adminUrl,
                    writeUrl,
                    readUrl,
                    signingKey,
                    readKey: docKeys.readKey,
                    appId,
                    primaryChannel,
                    signalingUrls,
                    syncOpts,
                    pubsub,
                    roomDiscovery,
                });
            }
            catch (err) {
                await releaseHelia();
                throw err;
            }
        },
        async open(url) {
            const parsed = await parseUrl(url);
            const { ipnsName, keys } = parsed;
            // Check for forwarding record
            const fwdBytes = lookupForwardingRecord(ipnsName);
            if (fwdBytes) {
                const fwd = decodeForwardingRecord(fwdBytes);
                if (keys.rotationKey) {
                    const valid = await verifyForwardingRecord(fwd, keys.rotationKey);
                    if (!valid) {
                        throw new Error("Invalid forwarding record" +
                            " signature");
                    }
                }
                return this.open(fwd.newUrl);
            }
            await acquireHelia({ bootstrapPeers });
            try {
                const pubsub = getHeliaPubsub();
                acquireNodeRegistry(pubsub, () => getHelia());
                const userIce = options.rtc?.config?.iceServers;
                const syncOpts = {
                    peerOpts: {
                        config: {
                            iceServers: userIce ?? DEFAULT_ICE_SERVERS,
                        },
                    },
                    pubsub,
                };
                const cap = inferCapability(keys, channels);
                const subdocManager = createSubdocManager(ipnsName, channels, {
                    primaryNamespace: primaryChannel,
                });
                const nsKeys = keys.namespaceKeys ?? {};
                const syncManager = setupNamespaceRooms(ipnsName, subdocManager, nsKeys, signalingUrls, syncOpts);
                const awarenessRoom = setupAwarenessRoom(ipnsName, keys.awarenessRoomPassword ?? "", signalingUrls, syncOpts);
                const roomDiscovery = startRoomDiscovery(getHelia(), appId);
                const adminUrl = keys.rotationKey
                    ? await buildUrl(origin, ipnsName, keys)
                    : null;
                const writeUrl = keys.ipnsKeyBytes
                    ? await buildUrl(origin, ipnsName, narrowCapability(keys, {
                        namespaces: [...cap.namespaces],
                        canPushSnapshots: true,
                    }))
                    : null;
                const readUrl = await buildUrl(origin, ipnsName, narrowCapability(keys, {
                    namespaces: [],
                }));
                let signingKey = null;
                if (keys.ipnsKeyBytes) {
                    signingKey =
                        await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
                }
                const doc = createDoc({
                    subdocManager,
                    syncManager,
                    awarenessRoom,
                    cap,
                    keys,
                    ipnsName,
                    origin,
                    channels,
                    adminUrl,
                    writeUrl,
                    readUrl,
                    signingKey,
                    readKey: keys.readKey,
                    appId,
                    primaryChannel,
                    signalingUrls,
                    syncOpts,
                    pubsub,
                    roomDiscovery,
                    performInitialResolve: !!keys.readKey,
                });
                return doc;
            }
            catch (err) {
                await releaseHelia();
                throw err;
            }
        },
        isDocUrl(url) {
            try {
                const parsed = new URL(url);
                const prefix = origin.replace(/\/$/, "")
                    + "/doc/";
                const orig = new URL(prefix).origin;
                const path = new URL(prefix).pathname;
                return parsed.origin === orig
                    && parsed.pathname.startsWith(path)
                    && parsed.hash.length > 1;
            }
            catch {
                return false;
            }
        },
        docIdFromUrl(url) {
            return docIdFromUrl(url);
        },
    };
}
export { encodeForwardingRecord, decodeForwardingRecord, verifyForwardingRecord, clearForwardingStore, } from "./forwarding.js";
export { getHelia } from "./helia.js";
export { createAutoSaver, } from "./auto-save.js";
export { truncateUrl, docIdFromUrl } from "./url-utils.js";
export { NODE_CAPS_TOPIC, _resetNodeRegistry, } from "./node-registry.js";
//# sourceMappingURL=index.js.map