/**
 * doc-feeds.ts — Factory for reactive Feed declarations
 * used by createDoc.
 *
 * Pure construction: creates feeds and derived
 * projections, returns them for create-doc.ts to wire
 * into the Doc lifecycle. No side effects beyond the
 * setTimeout for the mesh grace timer.
 */

import type {
  DocState,
  DocStatus,
  SaveState,
  DocRole,
  LoadingState,
  GossipActivity,
  VersionHistory,
} from "./facts.js";
import { initialDocState } from "./facts.js";
import { createFeed } from "./feed.js";
import type { Feed, WritableFeed } from "./feed.js";
import { projectFeed } from "./project-feed.js";
import { selectStatus, selectSaveState } from "./state-selectors.js";
import {
  deriveStatus,
  loadingStateChanged,
  MESH_GRACE_MS,
} from "./doc-status.js";
import type { SnapshotEvent, VersionInfo } from "./create-doc.js";

/** Snapshot validation error info. */
export type ValidationErrorInfo = {
  cid: string;
  message: string;
} | null;

/** Parameters for {@link createDocFeeds}. */
export interface DocFeedsParams {
  ipnsName: string;
  role: DocRole;
  channels: string[];
  appId: string;
  /** Timestamp (ms) when the Doc was created. Used
   *  for mesh grace period derivation. */
  createdAt: number;
}

/** All feeds returned by {@link createDocFeeds}. */
export interface DocFeeds {
  // --- Core state feeds ---
  docStateFeed: WritableFeed<DocState>;
  statusFeed: Feed<DocStatus>;
  saveStateFeed: Feed<SaveState>;

  // --- Tip / version feeds ---
  tipFeed: WritableFeed<VersionInfo | null>;
  loadingFeed: WritableFeed<LoadingState>;
  backedUpFeed: WritableFeed<boolean>;
  versionsFeed: WritableFeed<VersionHistory>;

  // --- Event feeds (never deduplicate) ---
  snapshotEventFeed: WritableFeed<SnapshotEvent | null>;
  ackEventFeed: WritableFeed<string | null>;
  nodeChangeFeed: WritableFeed<number>;
  dirtyCountFeed: WritableFeed<number>;

  // --- Misc feeds ---
  gossipActivityFeed: WritableFeed<GossipActivity>;
  persistenceErrorFeed: WritableFeed<string | null>;
  validationErrorFeed: WritableFeed<ValidationErrorInfo>;

  /** Timer handle for the mesh grace period.
   *  Caller must clearTimeout on destroy. */
  graceTimer: ReturnType<typeof setTimeout>;
}

const EMPTY_VERSION_HISTORY: VersionHistory = {
  entries: [],
  walking: false,
};

/**
 * Create all reactive feeds for a Doc instance.
 *
 * Pure construction — no subscriptions, no network,
 * no interpreter wiring. The only side effect is a
 * setTimeout for the mesh grace period transition.
 */
export function createDocFeeds(params: DocFeedsParams): DocFeeds {
  // --- DocState + derived projections ---
  const docStateInit = initialDocState({
    ipnsName: params.ipnsName,
    role: params.role,
    channels: params.channels,
    appId: params.appId,
  });
  // Set createdAt for mesh grace period and
  // re-derive status so initial value is
  // "connecting" instead of "offline".
  docStateInit.connectivity = {
    ...docStateInit.connectivity,
    createdAt: params.createdAt,
  };
  docStateInit.status = deriveStatus(docStateInit.connectivity);
  const docStateFeed: WritableFeed<DocState> =
    createFeed<DocState>(docStateInit);
  const statusFeed: Feed<DocStatus> = projectFeed(docStateFeed, selectStatus);
  const saveStateFeed: Feed<SaveState> = projectFeed(
    docStateFeed,
    selectSaveState,
  );

  // After grace period expires, re-derive status
  // so it transitions from "connecting" to "offline"
  // if nothing has connected.
  const graceTimer = setTimeout(() => {
    const current = docStateFeed.getSnapshot();
    const fresh = deriveStatus(current.connectivity);
    if (fresh !== current.status) {
      docStateFeed._update({
        ...current,
        status: fresh,
      });
    }
  }, MESH_GRACE_MS + 50);

  // --- Tip / version feeds ---
  const tipFeed: WritableFeed<VersionInfo | null> =
    createFeed<VersionInfo | null>(null, (a, b) => {
      if (a === b) return true;
      if (!a || !b) return false;
      return (
        a.cid.equals(b.cid) &&
        a.seq === b.seq &&
        a.ackedBy === b.ackedBy &&
        a.guaranteeUntil === b.guaranteeUntil &&
        a.retainUntil === b.retainUntil
      );
    });
  const loadingFeed: WritableFeed<LoadingState> = createFeed<LoadingState>(
    { status: "idle" },
    (a, b) => !loadingStateChanged(a, b),
  );
  const backedUpFeed: WritableFeed<boolean> = createFeed<boolean>(false);
  const versionsFeed: WritableFeed<VersionHistory> = createFeed<VersionHistory>(
    EMPTY_VERSION_HISTORY,
  );

  // --- Event feeds ---
  // For event-like notifications, use a comparator
  // that never deduplicates so every _update fires.
  const snapshotEventFeed: WritableFeed<SnapshotEvent | null> =
    createFeed<SnapshotEvent | null>(null, () => false);
  const ackEventFeed: WritableFeed<string | null> = createFeed<string | null>(
    null,
    () => false,
  );
  const nodeChangeFeed: WritableFeed<number> = createFeed<number>(
    0,
    () => false,
  );
  const dirtyCountFeed: WritableFeed<number> = createFeed<number>(
    0,
    () => false,
  );

  // --- Misc feeds ---
  const gossipActivityFeed: WritableFeed<GossipActivity> =
    createFeed<GossipActivity>("inactive");
  const persistenceErrorFeed: WritableFeed<string | null> = createFeed<
    string | null
  >(null);
  const validationErrorFeed: WritableFeed<ValidationErrorInfo> =
    createFeed<ValidationErrorInfo>(null);

  return {
    docStateFeed,
    statusFeed,
    saveStateFeed,
    tipFeed,
    loadingFeed,
    backedUpFeed,
    versionsFeed,
    snapshotEventFeed,
    ackEventFeed,
    nodeChangeFeed,
    dirtyCountFeed,
    gossipActivityFeed,
    persistenceErrorFeed,
    validationErrorFeed,
    graceTimer,
  };
}
