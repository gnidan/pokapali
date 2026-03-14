/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHelia, libp2pDefaults } from "helia";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { autoTLS } from "@ipshipyard/libp2p-auto-tls";
import { kadDHT } from "@libp2p/kad-dht";
import { ipnsValidator } from "ipns/validator";
import { ipnsSelector } from "ipns/selector";
import { LevelDatastore } from "datastore-level";
import { FsBlockstore } from "blockstore-fs";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import type { Helia } from "helia";
import type { PrivateKey } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { announceTopic } from "@pokapali/core/announce";
import { createDelegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { delegatedHTTPRoutingDefaults } from "@helia/routers";
import { createLogger } from "@pokapali/log";

// Even with client-mode DHT, peers accumulate via
// identify/ping. Set high enough that the connection
// manager doesn't reject browsers.
const MAX_CONNECTIONS = 512;

const DISCOVERY_TOPIC = "pokapali._peer-discovery._p2p._pubsub";
const SIGNALING_TOPIC = "/pokapali/signaling";
export const NODE_CAPS_TOPIC = "pokapali._node-caps._p2p._pubsub";
const RAW_CODEC = 0x55;
const PROVIDE_INTERVAL_MS = 5 * 60_000;
const LOG_INTERVAL_MS = 30_000;
const CAPS_INTERVAL_MS = 30_000;
const HEALTH_CHECK_MIN_MS = 60_000;
const HEALTH_CHECK_MAX_MS = 90_000;

const log = createLogger("relay");

export async function appIdToCID(appId: string): Promise<CID> {
  const bytes = new TextEncoder().encode("pokapali-relay:" + appId);
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

async function networkCID(): Promise<CID> {
  const bytes = new TextEncoder().encode("pokapali-network");
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

const DEFAULT_WS_PORT = 4003;
const KEY_FILENAME = "relay-key.bin";

/**
 * Derive an HTTPS URL from a WSS multiaddr.
 * e.g. /dns4/1-2-3-4.xxx.libp2p.direct/tcp/4003/tls/ws
 * → https://1-2-3-4.xxx.libp2p.direct:4443
 */
export function deriveHttpUrl(
  wssMultiaddr: string,
  httpsPort: number,
): string | undefined {
  // Prefer /sni/<host>/ — autoTLS uses this format
  // on ip4/ip6 addrs with the .libp2p.direct hostname.
  const sni = wssMultiaddr.match(/\/sni\/([^/]+)\//);
  if (sni) return `https://${sni[1]}:${httpsPort}`;
  // Fallback: /dns4/<host>/tcp/... or /dns6/<host>/tcp/...
  const dns = wssMultiaddr.match(/\/(dns[46])\/([^/]+)\/tcp/);
  if (dns) return `https://${dns[2]}:${httpsPort}`;
  return undefined;
}

/**
 * Derive httpUrl from the TLS cert SAN and relay's
 * public IP. Used when SNI multiaddr isn't registered
 * yet at cert provision time.
 *
 * Cert SAN: *.k51qzi...libp2p.direct
 * Public IP: 144.202.54.236 (from /ip4/ multiaddrs)
 * Result: https://144-202-54-236.k51qzi...libp2p.direct:4443
 */
export function deriveHttpUrlFromCert(
  certPem: string,
  multiaddrs: string[],
  httpsPort: number,
): string | undefined {
  // Extract wildcard domain from cert SAN.
  // PEM is base64-encoded — decode to DER bytes
  // where the domain appears as raw ASCII text.
  let domain: string | undefined;
  try {
    const lines = certPem.split("\n").filter((l) => !l.startsWith("-----"));
    const der = Buffer.from(lines.join(""), "base64");
    const text = der.toString("latin1");
    const m = text.match(/\*\.([a-z0-9]+\.libp2p\.direct)/);
    if (m) domain = m[1];
  } catch {
    // Not a valid PEM — try raw match as fallback
    const m = certPem.match(/\*\.([a-z0-9]+\.libp2p\.direct)/);
    if (m) domain = m[1];
  }
  if (!domain) return undefined;

  // Find our public IPv4 from non-circuit multiaddrs
  const ipMatch = multiaddrs
    .filter((a) => !a.includes("/p2p-circuit/"))
    .map((a) => a.match(/^\/ip4\/((?:\d+\.){3}\d+)\//))
    .find((m) => m && !m[1].startsWith("127."));
  if (!ipMatch) return undefined;

  const ip = ipMatch[1];
  const dashed = ip.replace(/\./g, "-");
  return `https://${dashed}.${domain}:${httpsPort}`;
}

async function loadOrCreateKey(storagePath: string): Promise<PrivateKey> {
  const keyPath = join(storagePath, KEY_FILENAME);
  try {
    const buf = await readFile(keyPath);
    const key = privateKeyFromProtobuf(buf);
    log.info("loaded existing key from", keyPath);
    return key;
  } catch {
    // Generate new key and persist it
    const key = await generateKeyPair("Ed25519");
    await mkdir(storagePath, { recursive: true });
    await writeFile(keyPath, privateKeyToProtobuf(key));
    log.info("generated new key, saved to", keyPath);
    return key;
  }
}

export interface NodeNeighbor {
  peerId: string;
  role?: string;
}

export interface NodeCapabilities {
  version: 2;
  peerId: string;
  roles: string[];
  neighbors?: NodeNeighbor[];
  browserCount?: number;
  /** Public WSS addresses for direct dialing. */
  addrs?: string[];
  /** HTTPS block endpoint URL. */
  httpUrl?: string;
}

export function encodeNodeCaps(caps: NodeCapabilities): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(caps));
}

export function decodeNodeCaps(data: Uint8Array): NodeCapabilities | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(data));
    if (
      (obj?.version !== 1 && obj?.version !== 2) ||
      typeof obj.peerId !== "string" ||
      !Array.isArray(obj.roles)
    ) {
      return null;
    }
    return obj as NodeCapabilities;
  } catch {
    return null;
  }
}

export interface RelayConfig {
  storagePath: string;
  wsPort?: number;
  // Public multiaddrs to announce (e.g. for autoTLS).
  // Needed so autoTLS knows our public IP before any
  // peers connect and report observed addresses.
  announceAddrs?: string[];
  // App IDs to subscribe to announcement topics for.
  // Subscribes to /pokapali/app/{appId}/announce for
  // each ID, so the relay joins the GossipSub mesh
  // and can forward announcements to the pinner.
  pinAppIds?: string[];
  // Node roles to advertise (e.g. ["relay"],
  // ["pinner"], or ["relay", "pinner"]).
  // If omitted, inferred: "pinner" if pinAppIds
  // is non-empty, otherwise empty.
  roles?: string[];
  // Custom delegated routing endpoint URL. When set,
  // overrides the default (delegated-ipfs.dev) for
  // IPNS resolve/publish via HTTP.
  delegatedRoutingUrl?: string;
  // Skip autoTLS cert provisioning. Useful for
  // ephemeral/test relays that don't need HTTPS.
  noTls?: boolean;
}

export interface Relay {
  stop(): Promise<void>;
  multiaddrs(): string[];
  peerId(): string;
  helia: Helia;
  /** Set by bin/node.ts once the HTTPS block server
   *  is listening. Included in caps advertisements. */
  httpUrl: string | undefined;
}

export async function startRelay(config: RelayConfig): Promise<Relay> {
  const wsPort = config.wsPort ?? DEFAULT_WS_PORT;
  const privateKey = await loadOrCreateKey(config.storagePath);
  const datastore = new LevelDatastore(join(config.storagePath, "datastore"));
  await datastore.open();

  const rawBlockstore = new FsBlockstore(
    join(config.storagePath, "blockstore"),
  );
  await rawBlockstore.open();
  // blockstore-fs@3 get() returns AsyncGenerator
  // <Uint8Array>, not Promise<Uint8Array>. Wrap to
  // match the Blockstore interface Helia expects.
  const blockstore = {
    ...rawBlockstore,
    open: () => rawBlockstore.open(),
    close: () => rawBlockstore.close(),
    put: (k: CID, v: Uint8Array) => rawBlockstore.put(k, v),
    has: (k: CID) => rawBlockstore.has(k),
    delete: (k: CID) => rawBlockstore.delete(k),
    async get(key: CID): Promise<Uint8Array> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of rawBlockstore.get(key)) {
        chunks.push(chunk);
      }
      if (chunks.length === 1) return chunks[0];
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      return merged;
    },
  };

  const { multiaddr } = await import("@multiformats/multiaddr");
  const bootstrapAddrs = [
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
  ];

  // Use fixed ports so firewall rules are predictable.
  const listen = [
    "/ip4/0.0.0.0/tcp/4001",
    "/ip6/::/tcp/4001",
    `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
    `/ip6/::/tcp/${wsPort}/ws`,
    "/p2p-circuit",
  ];

  // Relay peer IDs discovered via DHT. Created before
  // Helia so the appSpecificScore callback can
  // reference it. Populated in findAndDialProviders.
  const knownRelayPeerIds = new Set<string>();

  const defaults = libp2pDefaults();
  const helia = (await createHelia({
    blockstore: blockstore as any,
    datastore: datastore as any,
    libp2p: {
      ...defaults,
      privateKey,
      addresses: {
        ...defaults.addresses,
        listen,
        appendAnnounce: config.announceAddrs,
      },
      peerDiscovery: [],
      connectionManager: {
        ...defaults.connectionManager,
        maxConnections: MAX_CONNECTIONS,
        maxIncomingPendingConnections: 10,
      },
      services: (() => {
        const svc = {
          ...defaults.services,
          // Client-mode DHT: we provide records but don't
          // serve DHT queries, avoiding inbound
          // connections from DHT walkers.
          dht: kadDHT({
            clientMode: true,
            validators: { ipns: ipnsValidator },
            selectors: { ipns: ipnsSelector },
          }),
          pubsub: gossipsub({
            // Mesh routing: let GossipSub manage
            // message forwarding via mesh peers.
            // floodPublish was needed with only 2
            // relays (mesh couldn't form). With 4+
            // relays connected via DHT discovery and
            // tagged to prevent pruning, mesh routing
            // works reliably.
            floodPublish: false,
            allowPublishToZeroTopicPeers: true,
            // D=3 is achievable with 4 relays (3
            // peers). Dlo=3 maintains full mesh
            // before triggering GRAFT, reducing
            // isolation risk when a relay briefly
            // drops. Scales naturally as more relays
            // join — GossipSub adds up to Dhi mesh
            // peers.
            D: 3,
            Dlo: 3,
            Dhi: 8,
            Dout: 1,
            Dscore: 1,
            // Disable IP colocation penalty. Browser
            // peers connect via p2p-circuit through
            // bootstrap relays, making them all appear
            // to share the relay's IP. Default threshold
            // of 10 is easily exceeded, causing -5.0
            // scores → pruning → mesh collapse.
            // Cap per-peer outbound buffer. Default is
            // Infinity — under high message volume (1000+
            // docs with inline blocks), unbounded buffers
            // delay heartbeats, causing mesh collapse.
            // 10MB allows ~30 inline-block messages queued
            // per peer before dropping.
            maxOutboundBufferSize: 10 * 1024 * 1024,
            scoreParams: {
              IPColocationFactorWeight: 0,
              appSpecificScore: (peerId: string) =>
                knownRelayPeerIds.has(peerId) ? 100 : 0,
              appSpecificWeight: 1,
            },
          }),
          ...(config.noTls
            ? {}
            : {
                autoTLS: autoTLS({
                  autoConfirmAddress: true,
                }),
              }),
        };
        // Remove circuit relay server — we don't need to
        // relay for the IPFS network, it floods us with
        // connections.
        delete (svc as any).relay;
        // Override delegated routing URL if specified.
        if (config.delegatedRoutingUrl) {
          (svc as any).delegatedRouting = () =>
            createDelegatedRoutingV1HttpApiClient(
              config.delegatedRoutingUrl!,
              delegatedHTTPRoutingDefaults(),
            );
          log.info("delegated routing:", config.delegatedRoutingUrl);
        }
        return svc;
      })(),
    },
  })) as Helia;

  log.info("started, peer ID:", helia.libp2p.peerId);

  const addrs = helia.libp2p.getMultiaddrs();
  for (const ma of addrs) {
    log.info("  listening:", ma.toString());
  }

  // Dial ONE bootstrap peer to trigger self:peer:update
  // (needed for autoTLS cert provisioning).
  log.info("dialing bootstrap peer...");
  for (const addr of bootstrapAddrs) {
    try {
      await helia.libp2p.dial(multiaddr(addr));
      log.info("  dialed", addr.split("/p2p/")[1]?.slice(0, 12));
      break; // one is enough
    } catch {
      log.warn("  failed to dial", addr.split("/p2p/")[1]?.slice(0, 12));
    }
  }

  if (!config.noTls) {
    // Wait for autoTLS cert. Give it a grace period
    // to arrive quickly (from cache). If it doesn't,
    // start closing connections so the forge can dial
    // back without getting crowded out by DHT peers.
    const CERT_WAIT_MS = 120_000;
    const CERT_GRACE_MS = 10_000;
    let certResolved = false;
    let closeTimer: ReturnType<typeof setInterval> | null = null;
    const certObtained = await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        certResolved = true;
        resolve(v);
      };
      const timer = setTimeout(() => {
        log.warn("autoTLS timeout, proceeding without WSS");
        done(false);
      }, CERT_WAIT_MS);

      helia.libp2p.addEventListener(
        "certificate:provision",
        () => {
          clearTimeout(timer);
          log.info("certificate obtained!");
          done(true);
        },
        { once: true },
      );

      // After grace period, if cert still hasn't
      // arrived, start closing connections so the
      // forge can dial back.
      const graceTimer = setTimeout(() => {
        if (certResolved) return;
        const closeAll = async () => {
          const conns = helia.libp2p.getConnections();
          log.debug(`closing ${conns.length}`, `connections for cert`);
          await Promise.allSettled(conns.map((c) => c.close()));
        };
        log.debug("cert not yet obtained, closing conns");
        closeAll();
        closeTimer = setInterval(closeAll, 3_000);
      }, CERT_GRACE_MS);

      // Clean up grace timer if cert arrives early
      helia.libp2p.addEventListener(
        "certificate:provision",
        () => clearTimeout(graceTimer),
        { once: true },
      );
    });

    if (closeTimer) clearInterval(closeTimer);

    if (certObtained) {
      const wssAddrs = helia.libp2p
        .getMultiaddrs()
        .filter((ma) => ma.toString().includes("/tls/"));
      for (const a of wssAddrs) {
        log.info("  WSS:", a.toString());
      }
    }
  } else {
    log.info("TLS disabled, skipping cert wait");
  }

  // Re-dial bootstrap peers — the closeAll() during cert
  // wait killed all DHT peers, so we need to rebuild the
  // routing table before we can provide.
  log.info("re-dialing bootstrap peers...");
  for (const addr of bootstrapAddrs) {
    try {
      await helia.libp2p.dial(multiaddr(addr));
      log.info("  dialed", addr.split("/p2p/")[1]?.slice(0, 12));
    } catch {
      log.warn("  failed to dial", addr.split("/p2p/")[1]?.slice(0, 12));
    }
  }

  // Subscribe to the discovery topic so this node
  // joins the GossipSub mesh and relays peer
  // announcements between browsers.
  const pubsub = (helia.libp2p.services as any).pubsub;
  pubsub.subscribe(DISCOVERY_TOPIC);
  pubsub.subscribe(SIGNALING_TOPIC);
  log.info("subscribed to", DISCOVERY_TOPIC);
  log.info("subscribed to", SIGNALING_TOPIC);

  // Subscribe to announcement topics for pinned apps
  for (const appId of config.pinAppIds ?? []) {
    const topic = announceTopic(appId);
    pubsub.subscribe(topic);
    log.info("subscribed to", topic);
  }

  // Capability advertisement
  pubsub.subscribe(NODE_CAPS_TOPIC);
  const roles =
    config.roles ??
    (() => {
      const inferred = ["relay"];
      if ((config.pinAppIds ?? []).length > 0) {
        inferred.push("pinner");
      }
      return inferred;
    })();
  const selfPeerId = helia.libp2p.peerId.toString();

  // Track peer roles from incoming caps messages
  // so we can distinguish relays/pinners from
  // browsers when building the neighbor list.
  const knownPeerRoles = new Map<string, string[]>();
  pubsub.addEventListener("message", (evt: any) => {
    const { detail } = evt;
    if (detail?.topic !== NODE_CAPS_TOPIC) return;
    const caps = decodeNodeCaps(detail.data);
    if (!caps || caps.peerId === selfPeerId) return;
    knownPeerRoles.set(caps.peerId, caps.roles);
  });

  // Mutable — set by bin/node.ts once the HTTPS
  // block server is listening. Referenced by
  // publishCaps() for caps advertisements.
  let httpUrl: string | undefined;

  function publishCaps() {
    // Build neighbor list from connected peers
    // with known roles (relays/pinners).
    const conns = helia.libp2p.getConnections();
    const connectedPids = new Set<string>();
    for (const conn of conns) {
      connectedPids.add((conn as any).remotePeer.toString());
    }

    // Prune stale entries from knownPeerRoles —
    // remove peers we're no longer connected to.
    for (const pid of knownPeerRoles.keys()) {
      if (!connectedPids.has(pid)) {
        knownPeerRoles.delete(pid);
      }
    }

    const neighbors: NodeNeighbor[] = [];
    let browserCount = 0;
    for (const pid of connectedPids) {
      const peerRoles = knownPeerRoles.get(pid);
      if (peerRoles && peerRoles.length > 0) {
        // Known relay/pinner — include as neighbor
        neighbors.push({
          peerId: pid,
          role: peerRoles[0],
        });
      } else {
        // Unknown role — assumed browser
        browserCount++;
      }
    }

    // Include public WSS addresses so browsers
    // that hear caps via GossipSub can dial us.
    const addrs = helia.libp2p
      .getMultiaddrs()
      .filter((ma) => ma.toString().includes("/tls/"))
      .map((ma) => ma.toString());

    log.info(
      `caps: ${neighbors.length} neighbors,` +
        ` ${browserCount} browsers,` +
        ` ${knownPeerRoles.size} known peers,` +
        ` ${addrs.length} addrs`,
    );
    const msg = encodeNodeCaps({
      version: 2,
      peerId: selfPeerId,
      roles,
      neighbors: neighbors.length > 0 ? neighbors : undefined,
      browserCount,
      addrs: addrs.length > 0 ? addrs : undefined,
      httpUrl,
    });
    pubsub.publish(NODE_CAPS_TOPIC, msg).catch((err: unknown) => {
      log.warn("caps publish failed:", err);
    });
  }

  // Publish immediately + on interval
  publishCaps();
  const capsInterval = setInterval(publishCaps, CAPS_INTERVAL_MS);
  log.info("advertising capabilities:", roles.join(", "));

  // Provide a single network-wide CID so browsers
  // can discover any relay regardless of app.
  const netCID = await networkCID();

  // Tag value for relay peers discovered via DHT.
  // Protects from connection manager pruning (pruner
  // drops lowest-value peers first). We do NOT use
  // GossipSub's `direct` set — adding peers to
  // `direct` excludes them from mesh, but mesh
  // membership is what we need for relay-to-relay
  // message delivery. Instead, we tag the connection
  // and let normal GossipSub mesh formation (D=3)
  // naturally GRAFT connected relays.
  const RELAY_PEER_TAG = "pokapali-relay-peer";
  const RELAY_PEER_TAG_VALUE = 100;

  /**
   * Find other relays providing the network CID and
   * dial them. This discovers relays via delegated
   * routing even when DHT provide fails, ensuring
   * relays connect to each other for GossipSub.
   *
   * After dialing, we tag the peer to protect the
   * connection from pruning. GossipSub's heartbeat
   * will naturally GRAFT connected topic subscribers
   * into the mesh.
   */
  async function findAndDialProviders() {
    const selfId = helia.libp2p.peerId.toString();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let found = 0;
      for await (const provider of helia.routing.findProviders(netCID, {
        signal: ctrl.signal,
      })) {
        found++;
        const pid = provider.id.toString();
        if (pid === selfId) continue;
        for (const ma of provider.multiaddrs) {
          try {
            await helia.libp2p.dial(ma, {
              signal: ctrl.signal,
            });
            log.info("dialed relay provider:" + ` ${ma.toString().slice(-20)}`);
            // Tag the peer so the connection manager
            // keeps it alive. GossipSub mesh formation
            // handles message routing from here.
            helia.libp2p.peerStore
              .merge(provider.id, {
                tags: {
                  [RELAY_PEER_TAG]: {
                    value: RELAY_PEER_TAG_VALUE,
                  },
                },
              })
              .catch((err) => {
                log.warn(
                  "peerStore.merge failed for" + ` ...${pid.slice(-8)}:`,
                  err,
                );
              });
            knownRelayPeerIds.add(pid);
            log.info(`tagged relay` + ` ...${pid.slice(-8)}`);
          } catch (err) {
            log.debug(
              "dial failed for provider" + ` ...${pid.slice(-8)}:`,
              (err as Error).message,
            );
          }
        }
      }
      clearTimeout(timer);
      log.debug(`findProviders found ${found} providers`);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("abort")) {
        log.error(`findProviders failed: ${msg}`);
      }
    }
  }

  async function provideAll() {
    // Discover and dial existing providers first
    // so relays connect to each other even if our
    // own provide fails.
    await findAndDialProviders();

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      await helia.routing.provide(netCID, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      log.debug("provide OK for network CID");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("abort")) {
        log.warn("provide TIMEOUT for network CID");
      } else {
        log.error(`provide FAIL for network CID: ${msg}`);
      }
    }
  }

  // Initial provide after DHT routing table has
  // time to populate from the persistent peer store
  // (afterStart() has a 20s timeout for serial
  // peer pings).
  setTimeout(() => {
    log.debug("initial provide starting...");
    provideAll();
  }, 45_000);

  // Re-provide after autoTLS certificate is obtained
  // so the DHT peer record includes WSS addresses.
  const onCertProvision = () => {
    log.info("certificate obtained, re-providing");
    setTimeout(() => provideAll(), 15_000);
  };
  helia.libp2p.addEventListener("certificate:provision", onCertProvision);

  // Periodic re-provide
  const provideInterval = setInterval(provideAll, PROVIDE_INTERVAL_MS);

  // --- Relay-to-relay health check ---
  //
  // Periodically verify connectivity to known relay
  // peers. Re-dial any that have silently dropped.
  // Jittered interval (60-90s) prevents thundering
  // herd across relays.
  function scheduleHealthCheck() {
    const jitter =
      HEALTH_CHECK_MIN_MS +
      Math.random() * (HEALTH_CHECK_MAX_MS - HEALTH_CHECK_MIN_MS);
    return setTimeout(async () => {
      const connectedPids = new Set(
        helia.libp2p.getConnections().map((c: any) => c.remotePeer.toString()),
      );
      for (const pid of knownRelayPeerIds) {
        if (connectedPids.has(pid)) continue;
        const short = pid.slice(-8);
        log.info(`health: relay ...${short} not connected,`, `re-dialing`);
        findAndDialProviders().catch(() => {});
        break; // one re-dial pass per check
      }
      healthTimer = scheduleHealthCheck();
    }, jitter);
  }
  let healthTimer = scheduleHealthCheck();

  // Periodic status logging
  let lastAddrCount = 0;
  const logInterval = setInterval(() => {
    const conns = helia.libp2p.getConnections();
    const peers = helia.libp2p.getPeers();
    const ma = helia.libp2p.getMultiaddrs();
    const gsTopics = pubsub.getTopics();
    const gsPeers = (pubsub as any).getPeers?.() ?? [];
    const gsSubs = gsTopics.flatMap((t: string) =>
      pubsub
        .getSubscribers(t)
        .map((p: any) => `${t}:${p.toString().slice(-8)}`),
    );
    // Check mesh state via public getMeshPeers API
    const meshInfo = gsTopics.map((t: string) => {
      const mp = pubsub.getMeshPeers?.(t);
      return mp ? `${t}:${mp.length}` : `${t}:?`;
    });
    log.debug(
      `${conns.length} conns,`,
      `${peers.length} peers,`,
      `gs: ${gsPeers.length} peers,`,
      `${gsSubs.length} subs,`,
      `topics: ${gsTopics},`,
      `mesh: ${meshInfo}`,
    );

    // Diagnostic: for each topic, show why peers
    // are/aren't mesh candidates
    const gs = pubsub as any;
    const backoffMap = gs.backoff as
      | Map<string, Map<string, number>>
      | undefined;
    const streamsOut = gs.streamsOutbound as Map<string, any> | undefined;
    for (const topic of gsTopics) {
      const subs = pubsub.getSubscribers(topic);
      if (subs.length === 0) continue;
      const topicMeshPeers = new Set(
        (pubsub.getMeshPeers?.(topic) ?? []).map((p: any) => p.toString()),
      );
      const topicBackoff = backoffMap?.get(topic);
      const details = subs.map((p: any) => {
        const id = p.toString();
        const short = id.slice(-8);
        const inMesh = topicMeshPeers.has(id) ? "M" : "-";
        const hasStream = streamsOut?.has(id) ? "S" : "!S";
        const score = gs.score?.score?.(id) ?? "?";
        const bo = topicBackoff?.has(id)
          ? `BO:${Math.round(
              ((topicBackoff.get(id) ?? 0) - Date.now()) / 1000,
            )}s`
          : "-";
        return (
          `${short}[${inMesh}${hasStream} ` +
          `sc:${typeof score === "number" ? score.toFixed(1) : score} ${bo}]`
        );
      });
      const shortTopic = topic.length > 30 ? "..." + topic.slice(-25) : topic;
      log.debug(`  ${shortTopic}: ${details.join(" ")}`);
    }

    if (ma.length !== lastAddrCount) {
      lastAddrCount = ma.length;
      for (const a of ma) {
        log.debug("  addr:", a.toString());
      }
    }
  }, LOG_INTERVAL_MS);

  return {
    helia,

    get httpUrl() {
      return httpUrl;
    },
    set httpUrl(url: string | undefined) {
      httpUrl = url;
    },

    async stop() {
      clearTimeout(healthTimer);
      clearInterval(provideInterval);
      clearInterval(logInterval);
      clearInterval(capsInterval);
      helia.libp2p.removeEventListener(
        "certificate:provision",
        onCertProvision,
      );
      await helia.stop();
      log.info("stopped");
    },

    multiaddrs() {
      return helia.libp2p.getMultiaddrs().map((ma) => ma.toString());
    },

    peerId() {
      return helia.libp2p.peerId.toString();
    },
  };
}
