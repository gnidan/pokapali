import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  Capability,
  CapabilityGrant,
  CapabilityKeys,
} from "@pokapali/capability";
import { narrowCapability, buildUrl } from "@pokapali/capability";
import { hexToBytes } from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { SubdocManager } from "@pokapali/subdocs";
import type {
  SyncManager,
  AwarenessRoom,
  SyncOptions,
  PubSubLike,
} from "@pokapali/sync";
import { CID } from "multiformats/cid";
import { getHelia, releaseHelia } from "./helia.js";
import { publishIPNS } from "./ipns-helpers.js";
import { announceSnapshot, MAX_INLINE_BLOCK_BYTES } from "./announce.js";
import { uploadBlock } from "./block-upload.js";
import type { RoomDiscovery } from "./peer-discovery.js";
import { createSnapshotLifecycle } from "./snapshot-lifecycle.js";
import { createSnapshotWatcher } from "./snapshot-watcher.js";
import type {
  SnapshotWatcher,
  LoadingState,
  GossipActivity,
} from "./snapshot-watcher.js";
import { createRelaySharing } from "./relay-sharing.js";
import type { RelaySharing } from "./relay-sharing.js";
import { getNodeRegistry } from "./node-registry.js";
import { createTopologySharing } from "./topology-sharing.js";
import type { TopologySharing } from "./topology-sharing.js";
import { buildTopologyGraph } from "./topology-graph.js";
import type { TopologyGraph } from "./topology-graph.js";
import { createLogger } from "@pokapali/log";
import { buildDiagnostics } from "./doc-diagnostics.js";
import type { Diagnostics } from "./doc-diagnostics.js";
import { rotateDoc } from "./doc-rotate.js";
import type { RotateResult } from "./doc-rotate.js";

const log = createLogger("core");

export type DocStatus = "connecting" | "synced" | "receiving" | "offline";

export type SaveState = "saved" | "unpublished" | "saving" | "dirty";

export type DocRole = "admin" | "writer" | "reader";

export interface DocUrls {
  readonly admin: string | null;
  readonly write: string | null;
  readonly read: string;
  /** Best available URL (admin > write > read). */
  readonly best: string;
}

export interface Doc {
  channel(name: string): Y.Doc;
  readonly provider: {
    readonly awareness: Awareness;
  };
  readonly awareness: Awareness;
  readonly capability: Capability;
  readonly urls: DocUrls;
  /** Role derived from capability. */
  readonly role: DocRole;
  invite(grant: CapabilityGrant): Promise<string>;
  readonly status: DocStatus;
  /** Persistence state (dirty → saving → saved). */
  readonly saveState: SaveState;
  /** Peer IDs of relays discovered for this app. */
  readonly relays: ReadonlySet<string>;
  /** Sum of all Y.Doc state vector clocks. */
  readonly clockSum: number;
  /** Last IPNS sequence number used for publish. */
  readonly ipnsSeq: number | null;
  /** Highest seq seen in GossipSub announcements. */
  readonly latestAnnouncedSeq: number;
  /** Current loading lifecycle state. */
  readonly loadingState: LoadingState;
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
  ready(): Promise<void>;
  publish(): Promise<void>;
  rotate(): Promise<RotateResult>;
  on(event: "status", cb: (status: DocStatus) => void): void;
  on(event: "publish-needed", cb: () => void): void;
  on(event: "snapshot", cb: () => void): void;
  on(event: "loading", cb: (state: LoadingState) => void): void;
  on(event: "ack", cb: (peerId: string) => void): void;
  on(event: "save", cb: (state: SaveState) => void): void;
  on(event: "node-change", cb: () => void): void;
  off(event: "status", cb: (status: DocStatus) => void): void;
  off(event: "publish-needed", cb: () => void): void;
  off(event: "snapshot", cb: () => void): void;
  off(event: "loading", cb: (state: LoadingState) => void): void;
  off(event: "ack", cb: (peerId: string) => void): void;
  off(event: "save", cb: (state: SaveState) => void): void;
  off(event: "node-change", cb: () => void): void;
  diagnostics(): Diagnostics;
  /** Merged topology graph from own connections,
   *  peer-reported relays (awareness), and
   *  relay-to-relay edges (node-registry). */
  topologyGraph(): TopologyGraph;
  history(): Promise<
    Array<{
      cid: CID;
      seq: number;
      ts: number;
    }>
  >;
  loadVersion(cid: CID): Promise<Record<string, Y.Doc>>;
  destroy(): void;
}

export interface DocParams {
  subdocManager: SubdocManager;
  syncManager: SyncManager;
  awarenessRoom: AwarenessRoom;
  cap: Capability;
  keys: CapabilityKeys;
  ipnsName: string;
  origin: string;
  channels: string[];
  adminUrl: string | null;
  writeUrl: string | null;
  readUrl: string;
  signingKey: Ed25519KeyPair | null;
  readKey: CryptoKey | undefined;
  appId: string;
  primaryChannel: string;
  signalingUrls: string[];
  syncOpts?: SyncOptions;
  pubsub?: PubSubLike;
  roomDiscovery?: RoomDiscovery;
  performInitialResolve?: boolean;
}

type SyncStatus = "connecting" | "connected" | "disconnected";

function computeStatus(
  syncStatus: SyncStatus,
  awarenessConnected: boolean,
  gossipActivity: GossipActivity,
): DocStatus {
  if (syncStatus === "connected") return "synced";
  if (syncStatus === "connecting") return "connecting";
  if (awarenessConnected) return "receiving";
  if (gossipActivity === "receiving") return "receiving";
  if (gossipActivity === "subscribed") {
    return "connecting";
  }
  return "offline";
}

function computeSaveState(isDirty: boolean, isSaving: boolean): SaveState {
  if (isSaving) return "saving";
  if (isDirty) return "dirty";
  return "saved";
}

/**
 * Populate the _meta subdoc with initial signing
 * key and namespace authorization entries.
 * Used by both create() and rotate().
 */
export function populateMeta(
  metaDoc: Y.Doc,
  signingPublicKey: Uint8Array,
  namespaceKeys: Record<string, Uint8Array>,
) {
  const canPush = metaDoc.getArray<Uint8Array>("canPushSnapshots");
  canPush.push([signingPublicKey]);
  const authorized = metaDoc.getMap("authorized");
  for (const [ns, key] of Object.entries(namespaceKeys)) {
    const arr = new Y.Array<Uint8Array>();
    authorized.set(ns, arr);
    arr.push([key]);
  }
}

export function createDoc(params: DocParams): Doc {
  const {
    subdocManager,
    syncManager,
    awarenessRoom,
    cap,
    keys,
    ipnsName,
    origin,
    channels,
    signingKey,
    readKey,
  } = params;

  let destroyed = false;
  let readyResolved = false;
  let resolveReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
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

  function getHttpUrls(): string[] {
    const urls: string[] = [];
    const reg = getNodeRegistry();
    if (reg) {
      for (const node of reg.nodes.values()) {
        if (node.httpUrl) urls.push(node.httpUrl);
      }
    }
    return urls;
  }

  const snapshotLC = createSnapshotLifecycle({
    getHelia: () => getHelia(),
    httpUrls: getHttpUrls,
  });
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  function emit(event: string, ...args: unknown[]) {
    const cbs = listeners.get(event);
    if (cbs) {
      for (const cb of cbs) cb(...args);
    }
  }

  // --- Status tracking (3 inputs) ---
  let gossipActivity: GossipActivity = "inactive";
  let isSaving = false;

  let lastStatus = computeStatus(
    syncManager.status,
    awarenessRoom.connected,
    gossipActivity,
  );
  let lastSaveState = computeSaveState(subdocManager.isDirty, isSaving);

  function checkStatus() {
    const next = computeStatus(
      syncManager.status,
      awarenessRoom.connected,
      gossipActivity,
    );
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

  function computeClockSum(): number {
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
  let relaySharing: RelaySharing | null = null;
  let topSharing: TopologySharing | null = null;
  let cleanupRelayConnect: (() => void) | null = null;
  if (params.roomDiscovery) {
    relaySharing = createRelaySharing({
      awareness: awarenessRoom.awareness,
      roomDiscovery: params.roomDiscovery,
    });
  }

  // Publish relay topology via awareness for graph.
  // Also forward node-registry changes as doc events.
  // When caps messages include addresses, feed them
  // to roomDiscovery so we can dial new relays.
  const knownPinnerPids = new Set<string>();
  const nodeChangeHandler = () => {
    emit("node-change");
    const reg = getNodeRegistry();
    if (reg) {
      // Fire guarantee query when a new pinner
      // appears in node-registry caps.
      let newPinner = false;
      for (const node of reg.nodes.values()) {
        if (
          node.roles.includes("pinner") &&
          !knownPinnerPids.has(node.peerId)
        ) {
          knownPinnerPids.add(node.peerId);
          newPinner = true;
        }
      }
      if (newPinner && snapshotWatcher) {
        snapshotWatcher.queryGuarantees();
      }
    }
    if (!params.roomDiscovery) return;
    if (!reg) return;
    const entries: {
      peerId: string;
      addrs: string[];
    }[] = [];
    for (const node of reg.nodes.values()) {
      if (node.addrs.length > 0) {
        entries.push({
          peerId: node.peerId,
          addrs: node.addrs,
        });
      }
    }
    if (entries.length > 0) {
      params.roomDiscovery.addExternalRelays(entries);
    }
  };
  try {
    const registry = getNodeRegistry();
    if (registry) {
      const helia = getHelia();
      topSharing = createTopologySharing({
        awareness: awarenessRoom.awareness,
        registry,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        libp2p: (helia as any).libp2p,
      });
      registry.on("change", nodeChangeHandler);
    }
  } catch (err) {
    log.warn("topology sharing init skipped:", (err as Error)?.message ?? err);
  }

  // Snapshot watching: announce subscription, IPNS
  // polling, re-announce for writers, initial resolve.
  let snapshotWatcher: SnapshotWatcher | null = null;
  if (readKey && params.pubsub && params.appId) {
    const rk = readKey;
    log.debug(
      "announce setup: pubsub=" + !!params.pubsub + " appId=" + params.appId,
    );
    snapshotWatcher = createSnapshotWatcher({
      appId: params.appId,
      ipnsName,
      pubsub: params.pubsub,
      getHelia: () => getHelia(),
      isWriter: cap.canPushSnapshots,
      ipnsPublicKeyBytes: hexToBytes(ipnsName),
      performInitialResolve: params.performInitialResolve,
      httpUrls: getHttpUrls,
      onSnapshot: async (cid) => {
        const applied = await snapshotLC.applyRemote(cid, rk, (plaintext) =>
          subdocManager.applySnapshot(plaintext),
        );
        if (applied) {
          snapshotLC.setLastIpnsSeq(computeClockSum());
          // Track the loaded CID for ack matching so
          // guarantee responses from pinners that
          // already hold this snapshot set
          // ackedCurrentCid.
          snapshotWatcher?.trackCidForAcks(cid.toString());
          emit("snapshot");
          markReady();
        }
      },
    });

    snapshotWatcher.on("guarantee-query", () => {
      emit("guarantee-query");
    });
    snapshotWatcher.on("ack", (peerId) => {
      emit("ack", peerId);
    });
    snapshotWatcher.on("gossip-activity", (activity) => {
      gossipActivity = activity;
      checkStatus();
      emit("gossip-activity", activity);
    });
    snapshotWatcher.on("fetch-state", (state) => {
      emit("loading", state);
      // If we return to idle or hit permanent
      // failure without ever applying a snapshot,
      // the document is as ready as it gets —
      // mount the editor so the user sees status
      // indicators instead of a blank loading
      // screen.
      if (
        (state.status === "idle" || state.status === "failed") &&
        !readyResolved &&
        !snapshotWatcher?.hasAppliedSnapshot
      ) {
        markReady();
      }
    });

    // Periodically re-announce the latest snapshot
    // so pinners and new peers discover it even if
    // the original writer is offline.
    snapshotWatcher.startReannounce(
      () => snapshotLC.prev,
      (cidStr) => snapshotLC.getBlock(cidStr),
      () => snapshotLC.lastIpnsSeq,
    );

    // Immediately re-announce when a new relay
    // connects so its pinner discovers the latest
    // snapshot without waiting for the interval.
    if (params.roomDiscovery) {
      const rd = params.roomDiscovery;
      const sw = snapshotWatcher;
      const connectHandler = (evt: CustomEvent) => {
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
    topSharing?.destroy();
    try {
      getNodeRegistry()?.off("change", nodeChangeHandler);
    } catch (err) {
      log.warn("off('change') cleanup error:", (err as Error)?.message ?? err);
    }
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
    get awareness(): Awareness {
      return awarenessRoom.awareness;
    },
  };

  return {
    channel(name: string): Y.Doc {
      assertNotDestroyed();
      try {
        return subdocManager.subdoc(name);
      } catch {
        throw new Error(
          `Unknown channel "${name}". ` + "Configured: " + channels.join(", "),
        );
      }
    },

    get provider() {
      return providerObj;
    },

    get awareness(): Awareness {
      return awarenessRoom.awareness;
    },

    get capability(): Capability {
      return cap;
    },

    get urls(): DocUrls {
      return {
        admin: params.adminUrl,
        write: params.writeUrl,
        read: params.readUrl,
        get best(): string {
          return params.adminUrl ?? params.writeUrl ?? params.readUrl;
        },
      };
    },

    get role(): DocRole {
      if (cap.isAdmin) return "admin";
      if (cap.namespaces.size > 0) return "writer";
      return "reader";
    },

    async invite(grant: CapabilityGrant): Promise<string> {
      assertNotDestroyed();
      if (grant.namespaces) {
        for (const ns of grant.namespaces) {
          if (!cap.namespaces.has(ns)) {
            throw new Error(
              `Cannot grant "${ns}" ` + "— not in own capability",
            );
          }
        }
      }
      if (grant.canPushSnapshots && !cap.canPushSnapshots) {
        throw new Error(
          "Cannot grant canPushSnapshots " + "— not in own capability",
        );
      }
      const narrowed = narrowCapability(keys, grant);
      return buildUrl(origin, ipnsName, narrowed);
    },

    get status(): DocStatus {
      return computeStatus(
        syncManager.status,
        awarenessRoom.connected,
        gossipActivity,
      );
    },

    get saveState(): SaveState {
      return computeSaveState(subdocManager.isDirty, isSaving);
    },

    get relays(): ReadonlySet<string> {
      return params.roomDiscovery?.relayPeerIds ?? new Set();
    },

    get clockSum(): number {
      return computeClockSum();
    },

    get ipnsSeq(): number | null {
      return snapshotLC.lastIpnsSeq;
    },

    get latestAnnouncedSeq(): number {
      return snapshotWatcher?.latestAnnouncedSeq ?? 0;
    },

    get loadingState(): LoadingState {
      return (
        snapshotWatcher?.fetchState ?? {
          status: "idle",
        }
      );
    },

    get hasAppliedSnapshot(): boolean {
      return snapshotWatcher?.hasAppliedSnapshot ?? false;
    },

    get ackedBy(): ReadonlySet<string> {
      return snapshotWatcher?.ackedBy ?? new Set();
    },

    get guaranteeUntil(): number | null {
      return snapshotWatcher?.guaranteeUntil ?? null;
    },

    get retainUntil(): number | null {
      return snapshotWatcher?.retainUntil ?? null;
    },

    ready(): Promise<void> {
      return readyPromise;
    },

    async publish(): Promise<void> {
      assertNotDestroyed();
      if (!cap.canPushSnapshots || !signingKey || !readKey) {
        return;
      }
      isSaving = true;
      checkSaveState();

      const plaintext = subdocManager.encodeAll();
      const clockSum = this.clockSum;
      const { cid, block } = await snapshotLC.push(
        plaintext,
        readKey,
        signingKey,
        clockSum,
      );

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
      log.info("publish: cid=" + cidShort + "... clockSum=" + clockSum);
      (async () => {
        const helia = getHelia();
        log.debug("blockstore.put...", cidShort + "...");
        await Promise.resolve(helia.blockstore.put(cid, block));
        log.debug("blockstore.put done," + " publishing IPNS...");
        await publishIPNS(helia, keys.ipnsKeyBytes!, cid, clockSum);
        log.debug("IPNS published, announcing...");
        if (params.appId && params.pubsub) {
          if (block.length > MAX_INLINE_BLOCK_BYTES) {
            // Large block: upload via HTTP, then
            // announce without inline data.
            const urls = getHttpUrls();
            if (urls.length > 0) {
              await uploadBlock(cid, block, urls);
            }
            await announceSnapshot(
              params.pubsub,
              params.appId,
              ipnsName,
              cid.toString(),
              clockSum,
              // omit block — too large for GossipSub
            );
          } else {
            await announceSnapshot(
              params.pubsub,
              params.appId,
              ipnsName,
              cid.toString(),
              clockSum,
              block,
            );
          }
          log.debug("announce sent");
        }
      })().catch((err: unknown) => {
        log.error("IPNS publish/announce failed:", err);
      });
    },

    async rotate(): Promise<RotateResult> {
      assertNotDestroyed();
      const result = await rotateDoc(
        {
          cap,
          keys,
          ipnsName,
          origin,
          channels,
          appId: params.appId,
          primaryChannel: params.primaryChannel,
          signalingUrls: params.signalingUrls,
          syncOpts: params.syncOpts,
          pubsub: params.pubsub,
          subdocManager,
        },
        createDoc,
        populateMeta,
      );
      teardown();
      return result as RotateResult;
    },

    /* eslint-disable @typescript-eslint/no-explicit-any */
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },

    off(event: string, cb: (...args: any[]) => void) {
      listeners.get(event)?.delete(cb);
    },
    /* eslint-enable @typescript-eslint/no-explicit-any */

    diagnostics(): Diagnostics {
      assertNotDestroyed();
      return buildDiagnostics({
        snapshotWatcher,
        roomDiscovery: params.roomDiscovery,
        awareness: awarenessRoom.awareness,
        clockSum: computeClockSum(),
        ipnsSeq: snapshotLC.lastIpnsSeq,
      });
    },

    topologyGraph(): TopologyGraph {
      assertNotDestroyed();
      return buildTopologyGraph(this.diagnostics(), awarenessRoom.awareness);
    },

    async history() {
      assertNotDestroyed();
      return snapshotLC.history();
    },

    async loadVersion(cid: CID) {
      assertNotDestroyed();
      if (!readKey) {
        throw new Error("No readKey available");
      }
      return snapshotLC.loadVersion(cid, readKey);
    },

    destroy(): void {
      if (destroyed) return;
      teardown();
    },
  } as Doc;
}
