import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  Capability,
  CapabilityGrant,
  CapabilityKeys,
} from "@pokapali/capability";
import {
  inferCapability,
  narrowCapability,
  buildUrl,
  parseUrl,
} from "@pokapali/capability";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { createSubdocManager } from "@pokapali/subdocs";
import type { SubdocManager } from "@pokapali/subdocs";
import { setupNamespaceRooms, setupAwarenessRoom } from "@pokapali/sync";
import type { SyncManager, AwarenessRoom, SyncOptions } from "@pokapali/sync";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  walkChain,
} from "@pokapali/snapshot";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DAG_CBOR_CODE = 0x71;

export interface CollabLibOptions {
  appId?: string;
  namespaces: string[];
  primaryNamespace?: string;
  base: string;
  signalingUrls?: string[];
  peerOpts?: SyncOptions["peerOpts"];
}

export type DocStatus =
  | "connecting"
  | "syncing"
  | "synced"
  | "offline"
  | "unpushed-changes";

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
  inviteUrl(grant: CapabilityGrant): Promise<string>;
  readonly status: DocStatus;
  pushSnapshot(): Promise<void>;
  on(event: "status", cb: (status: DocStatus) => void): void;
  on(event: "snapshot-recommended", cb: () => void): void;
  on(event: "snapshot-applied", cb: () => void): void;
  off(event: "status", cb: (status: DocStatus) => void): void;
  off(event: "snapshot-recommended", cb: () => void): void;
  off(event: "snapshot-applied", cb: () => void): void;
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

export interface CollabLib {
  create(): Promise<CollabDoc>;
  open(url: string): Promise<CollabDoc>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type SyncStatus = "connecting" | "connected" | "disconnected";

function computeStatus(syncStatus: SyncStatus, isDirty: boolean): DocStatus {
  if (syncStatus === "disconnected") return "offline";
  if (syncStatus === "connecting") return "connecting";
  if (isDirty) return "unpushed-changes";
  return "synced";
}

interface CollabDocParams {
  subdocManager: SubdocManager;
  syncManager: SyncManager;
  awarenessRoom: AwarenessRoom;
  cap: Capability;
  keys: CapabilityKeys;
  ipnsName: string;
  base: string;
  namespaces: string[];
  adminUrl: string | null;
  writeUrl: string | null;
  readUrl: string;
  signingKey: Ed25519KeyPair | null;
  readKey: CryptoKey | undefined;
}

function createCollabDoc(params: CollabDocParams): CollabDoc {
  const {
    subdocManager,
    syncManager,
    awarenessRoom,
    cap,
    keys,
    ipnsName,
    base,
    namespaces,
    signingKey,
    readKey,
  } = params;

  let destroyed = false;
  let seq = 1;
  let prev: CID | null = null;
  const blocks = new Map<string, Uint8Array>();
  const listeners = new Map<string, Set<Function>>();

  function emit(event: string, ...args: unknown[]) {
    const cbs = listeners.get(event);
    if (cbs) {
      for (const cb of cbs) cb(...args);
    }
  }

  let lastStatus = computeStatus(syncManager.status, subdocManager.isDirty);

  function checkStatus() {
    const next = computeStatus(syncManager.status, subdocManager.isDirty);
    if (next !== lastStatus) {
      lastStatus = next;
      emit("status", next);
    }
  }

  subdocManager.on("dirty", () => {
    checkStatus();
    emit("snapshot-recommended");
  });

  function assertNotDestroyed() {
    if (destroyed) {
      throw new Error("CollabDoc destroyed");
    }
  }

  const providerObj = {
    get awareness(): Awareness {
      return awarenessRoom.awareness;
    },
  };

  return {
    subdoc(ns: string): Y.Doc {
      assertNotDestroyed();
      try {
        return subdocManager.subdoc(ns);
      } catch {
        throw new Error(
          `Unknown namespace "${ns}". ` +
            "Configured: " +
            namespaces.join(", "),
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

    adminUrl: params.adminUrl,
    writeUrl: params.writeUrl,
    readUrl: params.readUrl,

    async inviteUrl(grant: CapabilityGrant): Promise<string> {
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
      return buildUrl(base, ipnsName, narrowed);
    },

    get status(): DocStatus {
      return computeStatus(syncManager.status, subdocManager.isDirty);
    },

    async pushSnapshot(): Promise<void> {
      assertNotDestroyed();
      if (!cap.canPushSnapshots || !signingKey || !readKey) {
        return;
      }
      const plaintext = subdocManager.encodeAll();
      const block = await encodeSnapshot(
        plaintext,
        readKey,
        prev,
        seq,
        Date.now(),
        signingKey,
      );
      const hash = await sha256.digest(block);
      const cid = CID.createV1(DAG_CBOR_CODE, hash);
      blocks.set(cid.toString(), block);
      prev = cid;
      seq++;
      checkStatus();
    },

    on(
      event: string,
      // eslint-disable-next-line
      cb: (...args: any[]) => void,
    ) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },

    off(
      event: string,
      // eslint-disable-next-line
      cb: (...args: any[]) => void,
    ) {
      listeners.get(event)?.delete(cb);
    },

    async history() {
      assertNotDestroyed();
      if (!prev) return [];

      const getter = async (cid: CID) => {
        const block = blocks.get(cid.toString());
        if (!block) {
          throw new Error("Block not found: " + cid.toString());
        }
        return block;
      };

      const entries: Array<{
        cid: CID;
        seq: number;
        ts: number;
      }> = [];
      let currentCid: CID | null = prev;
      for await (const node of walkChain(prev, getter)) {
        entries.push({
          cid: currentCid!,
          seq: node.seq,
          ts: node.ts,
        });
        currentCid = node.prev;
      }
      return entries;
    },

    async loadVersion(cid: CID) {
      assertNotDestroyed();
      const block = blocks.get(cid.toString());
      if (!block) {
        throw new Error("Unknown CID: " + cid.toString());
      }
      if (!readKey) {
        throw new Error("No readKey available");
      }
      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(node, readKey);
      const result: Record<string, Y.Doc> = {};
      for (const [ns, bytes] of Object.entries(plaintext)) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        result[ns] = doc;
      }
      return result;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      syncManager.destroy();
      awarenessRoom.destroy();
      subdocManager.destroy();
    },
  } as CollabDoc;
}

export function createCollabLib(options: CollabLibOptions): CollabLib {
  const { namespaces, base } = options;
  const appId = options.appId ?? "";
  const primaryNamespace = options.primaryNamespace ?? namespaces[0];
  const signalingUrls = options.signalingUrls ?? ["wss://signaling.yjs.dev"];
  const syncOpts: SyncOptions | undefined = options.peerOpts
    ? { peerOpts: options.peerOpts }
    : undefined;

  return {
    async create(): Promise<CollabDoc> {
      const adminSecret = generateAdminSecret();
      const docKeys = await deriveDocKeys(adminSecret, appId, namespaces);

      const signingKey = await ed25519KeyPairFromSeed(docKeys.ipnsKeyBytes);
      const ipnsName = bytesToHex(signingKey.publicKey);

      const subdocManager = createSubdocManager(ipnsName, namespaces, {
        primaryNamespace,
      });

      const syncManager = setupNamespaceRooms(
        ipnsName,
        subdocManager,
        docKeys.namespaceKeys,
        signalingUrls,
        syncOpts,
      );

      const awarenessRoom = setupAwarenessRoom(
        ipnsName,
        docKeys.awarenessRoomPassword,
        signalingUrls,
        syncOpts,
      );

      const fullKeys: CapabilityKeys = {
        readKey: docKeys.readKey,
        ipnsKeyBytes: docKeys.ipnsKeyBytes,
        rotationKey: docKeys.rotationKey,
        awarenessRoomPassword: docKeys.awarenessRoomPassword,
        namespaceKeys: docKeys.namespaceKeys,
      };

      const adminUrl = await buildUrl(base, ipnsName, fullKeys);
      const writeUrl = await buildUrl(
        base,
        ipnsName,
        narrowCapability(fullKeys, {
          namespaces: [...namespaces],
          canPushSnapshots: true,
        }),
      );
      const readUrl = await buildUrl(
        base,
        ipnsName,
        narrowCapability(fullKeys, {
          namespaces: [],
        }),
      );

      const cap = inferCapability(fullKeys, namespaces);

      // Populate _meta doc
      const meta = subdocManager.metaDoc;
      const canPush = meta.getArray<Uint8Array>("canPushSnapshots");
      canPush.push([signingKey.publicKey]);
      const authorized = meta.getMap("authorized");
      for (const [ns, key] of Object.entries(docKeys.namespaceKeys)) {
        const arr = new Y.Array<Uint8Array>();
        authorized.set(ns, arr);
        arr.push([key]);
      }

      return createCollabDoc({
        subdocManager,
        syncManager,
        awarenessRoom,
        cap,
        keys: fullKeys,
        ipnsName,
        base,
        namespaces,
        adminUrl,
        writeUrl,
        readUrl,
        signingKey,
        readKey: docKeys.readKey,
      });
    },

    async open(url: string): Promise<CollabDoc> {
      const parsed = await parseUrl(url);
      const { ipnsName, keys } = parsed;

      const cap = inferCapability(keys, namespaces);

      const subdocManager = createSubdocManager(ipnsName, namespaces, {
        primaryNamespace,
      });

      const nsKeys = keys.namespaceKeys ?? {};
      const syncManager = setupNamespaceRooms(
        ipnsName,
        subdocManager,
        nsKeys,
        signalingUrls,
        syncOpts,
      );

      const awarenessRoom = setupAwarenessRoom(
        ipnsName,
        keys.awarenessRoomPassword ?? "",
        signalingUrls,
        syncOpts,
      );

      const adminUrl = keys.rotationKey
        ? await buildUrl(base, ipnsName, keys)
        : null;
      const writeUrl = keys.ipnsKeyBytes
        ? await buildUrl(
            base,
            ipnsName,
            narrowCapability(keys, {
              namespaces: [...cap.namespaces],
              canPushSnapshots: true,
            }),
          )
        : null;
      const readUrl = await buildUrl(
        base,
        ipnsName,
        narrowCapability(keys, {
          namespaces: [],
        }),
      );

      let signingKey: Ed25519KeyPair | null = null;
      if (keys.ipnsKeyBytes) {
        signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
      }

      return createCollabDoc({
        subdocManager,
        syncManager,
        awarenessRoom,
        cap,
        keys,
        ipnsName,
        base,
        namespaces,
        adminUrl,
        writeUrl,
        readUrl,
        signingKey,
        readKey: keys.readKey,
      });
    },
  };
}
