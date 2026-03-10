import { createLogger } from "@pokapali/log";
const log = createLogger("node-registry");
export const NODE_CAPS_TOPIC = "pokapali._node-caps._p2p._pubsub";
const STALE_MS = 90_000;
const PRUNE_INTERVAL_MS = 30_000;
function parseCapsMessage(data) {
    try {
        const obj = JSON.parse(new TextDecoder().decode(data));
        if (obj?.version !== 1 ||
            typeof obj.peerId !== "string" ||
            !Array.isArray(obj.roles)) {
            return null;
        }
        return obj;
    }
    catch {
        return null;
    }
}
export function createNodeRegistry(pubsub, getHelia) {
    const nodes = new Map();
    pubsub.subscribe(NODE_CAPS_TOPIC);
    log.debug("subscribed to", NODE_CAPS_TOPIC);
    function getConnectedPeerIds() {
        try {
            const helia = getHelia();
            const conns = helia.libp2p.getConnections();
            const pids = new Set();
            for (const conn of conns) {
                pids.add(conn.remotePeer.toString());
            }
            return pids;
        }
        catch {
            return new Set();
        }
    }
    const messageHandler = (evt) => {
        const { detail } = evt;
        if (detail?.topic !== NODE_CAPS_TOPIC)
            return;
        const caps = parseCapsMessage(detail.data);
        if (!caps)
            return;
        const connected = getConnectedPeerIds().has(caps.peerId);
        nodes.set(caps.peerId, {
            peerId: caps.peerId,
            roles: caps.roles,
            lastSeenAt: Date.now(),
            connected,
        });
        log.debug("node seen:", caps.peerId.slice(-8), caps.roles.join(","));
    };
    pubsub.addEventListener("message", messageHandler);
    // Prune stale entries and refresh connected state
    const pruneTimer = setInterval(() => {
        const now = Date.now();
        const connectedPids = getConnectedPeerIds();
        for (const [pid, node] of nodes) {
            if (now - node.lastSeenAt > STALE_MS) {
                nodes.delete(pid);
                log.debug("pruned stale node:", pid.slice(-8));
            }
            else {
                node.connected = connectedPids.has(pid);
            }
        }
    }, PRUNE_INTERVAL_MS);
    return {
        get nodes() {
            return nodes;
        },
        destroy() {
            clearInterval(pruneTimer);
            pubsub.removeEventListener("message", messageHandler);
        },
    };
}
// --- Singleton management ---
let sharedRegistry = null;
export function acquireNodeRegistry(pubsub, getHelia) {
    if (!sharedRegistry) {
        sharedRegistry = createNodeRegistry(pubsub, getHelia);
    }
    return sharedRegistry;
}
export function getNodeRegistry() {
    return sharedRegistry;
}
export function _resetNodeRegistry() {
    if (sharedRegistry) {
        sharedRegistry.destroy();
        sharedRegistry = null;
    }
}
//# sourceMappingURL=node-registry.js.map