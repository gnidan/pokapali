/**
 * state-selectors.test.ts — Tests for DocStatus and
 * SaveState feed projection via selectStatus and
 * selectSaveState.
 *
 * Layer 1: property test — random fact sequences,
 * verify projectFeed output matches deriveStatus/
 * deriveSaveState.
 *
 * Layer 2: subscription sequence test — known fact
 * sequences, verify exact transition sequence.
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import type { Fact, DocState } from "./facts.js";
import { initialDocState } from "./facts.js";
import { reduce } from "./reducers.js";
import { deriveStatus } from "./doc-status.js";
import { deriveSaveState } from "./reducers.js";
import { createFeed } from "./feed.js";
import { projectFeed } from "./project-feed.js";
import { selectStatus, selectSaveState } from "./state-selectors.js";

// -- CID pool (shared with property tests) --

const CID_POOL_SIZE = 3;
const cidPool: CID[] = [];
for (let i = 0; i < CID_POOL_SIZE; i++) {
  const digest = new Uint8Array(32);
  digest[0] = i;
  const hash = {
    code: 0x12,
    size: 32,
    digest,
    bytes: new Uint8Array([0x12, 0x20, ...digest]),
  };
  cidPool.push(CID.createV1(0x71, hash as any));
}

const arbPoolCid = fc.constantFrom(...cidPool);

// -- Fact arbitraries (subset covering status +
//    saveState transitions) --

const arbSyncStatus = fc.record({
  type: fc.constant("sync-status-changed" as const),
  ts: fc.nat({ max: 200_000 }),
  status: fc.constantFrom(
    "connecting" as const,
    "connected" as const,
    "disconnected" as const,
  ),
});

const arbAwareness = fc.record({
  type: fc.constant("awareness-status-changed" as const),
  ts: fc.nat({ max: 200_000 }),
  connected: fc.boolean(),
});

const arbGossipMsg = fc.record({
  type: fc.constant("gossip-message" as const),
  ts: fc.nat({ max: 200_000 }),
});

const arbGossipSub = fc.record({
  type: fc.constant("gossip-subscribed" as const),
  ts: fc.nat({ max: 200_000 }),
});

const arbRelayConnected = fc.record({
  type: fc.constant("relay-connected" as const),
  ts: fc.nat({ max: 200_000 }),
  peerId: fc.constantFrom("p1", "p2"),
});

const arbRelayDisconnected = fc.record({
  type: fc.constant("relay-disconnected" as const),
  ts: fc.nat({ max: 200_000 }),
  peerId: fc.constantFrom("p1", "p2"),
});

const arbContentDirty = fc.record({
  type: fc.constant("content-dirty" as const),
  ts: fc.nat({ max: 200_000 }),
  clockSum: fc.nat({ max: 10_000 }),
});

const arbPublishStarted = fc.record({
  type: fc.constant("publish-started" as const),
  ts: fc.nat({ max: 200_000 }),
});

const arbPublishSucceeded = fc.record({
  type: fc.constant("publish-succeeded" as const),
  ts: fc.nat({ max: 200_000 }),
  cid: arbPoolCid,
  seq: fc.nat({ max: 100 }),
});

const arbPublishFailed = fc.record({
  type: fc.constant("publish-failed" as const),
  ts: fc.nat({ max: 200_000 }),
  error: fc.constant("network error"),
});

const arbTick = fc.record({
  type: fc.constant("tick" as const),
  ts: fc.nat({ max: 200_000 }),
});

const arbFact: fc.Arbitrary<Fact> = fc.oneof(
  { weight: 3, arbitrary: arbSyncStatus },
  { weight: 2, arbitrary: arbAwareness },
  { weight: 2, arbitrary: arbGossipMsg },
  { weight: 1, arbitrary: arbGossipSub },
  { weight: 1, arbitrary: arbRelayConnected },
  { weight: 1, arbitrary: arbRelayDisconnected },
  { weight: 2, arbitrary: arbContentDirty },
  { weight: 1, arbitrary: arbPublishStarted },
  { weight: 1, arbitrary: arbPublishSucceeded },
  { weight: 1, arbitrary: arbPublishFailed },
  { weight: 1, arbitrary: arbTick },
) as fc.Arbitrary<Fact>;

const IDENTITY = {
  ipnsName: "sel-test",
  role: "writer" as const,
  channels: ["content"],
  appId: "app1",
};

function initial(): DocState {
  return initialDocState(IDENTITY);
}

// ------------------------------------------------
// Layer 1: Equivalence property tests
// ------------------------------------------------

describe("selectStatus equivalence", () => {
  it(
    "projectFeed(docStateFeed, selectStatus) " +
      "matches deriveStatus on every fact",
    () => {
      fc.assert(
        fc.property(fc.array(arbFact, { maxLength: 80 }), (facts) => {
          const docStateFeed = createFeed(initial());
          const statusFeed = projectFeed(docStateFeed, selectStatus);

          let state = initial();
          for (const fact of facts) {
            state = reduce(state, fact);
            docStateFeed._update(state);

            const projected = statusFeed.getSnapshot();
            const derived = deriveStatus(state.connectivity);
            expect(projected).toBe(derived);
          }
        }),
        { numRuns: 200 },
      );
    },
  );
});

describe("selectSaveState equivalence", () => {
  it(
    "projectFeed(docStateFeed, selectSaveState) " +
      "matches deriveSaveState on every fact",
    () => {
      fc.assert(
        fc.property(fc.array(arbFact, { maxLength: 80 }), (facts) => {
          const docStateFeed = createFeed(initial());
          const saveStateFeed = projectFeed(docStateFeed, selectSaveState);

          let state = initial();
          for (const fact of facts) {
            state = reduce(state, fact);
            docStateFeed._update(state);

            const projected = saveStateFeed.getSnapshot();
            const derived = deriveSaveState(state.content, state.chain);
            expect(projected).toBe(derived);
          }
        }),
        { numRuns: 200 },
      );
    },
  );
});

// ------------------------------------------------
// Layer 2: Subscription sequence tests
// ------------------------------------------------

describe("status subscription transitions", () => {
  it(
    "connect → sync → disconnect → reconnect " + "produces correct transitions",
    () => {
      const docStateFeed = createFeed(initial());
      const statusFeed = projectFeed(docStateFeed, selectStatus);

      const transitions: string[] = [];
      statusFeed.subscribe(() => {
        transitions.push(statusFeed.getSnapshot());
      });

      let state = initial();
      const facts: Fact[] = [
        {
          type: "sync-status-changed",
          ts: 100,
          status: "connecting",
        },
        {
          type: "sync-status-changed",
          ts: 200,
          status: "connected",
        },
        {
          type: "sync-status-changed",
          ts: 300,
          status: "disconnected",
        },
        {
          type: "sync-status-changed",
          ts: 400,
          status: "connected",
        },
      ];

      for (const fact of facts) {
        state = reduce(state, fact);
        docStateFeed._update(state);
      }

      expect(transitions).toEqual([
        "connecting",
        "synced",
        "offline",
        "synced",
      ]);
    },
  );
});

describe("status reaching receiving", () => {
  it(
    "gossip-message with disconnected sync " + "produces receiving status",
    () => {
      const docStateFeed = createFeed(initial());
      const statusFeed = projectFeed(docStateFeed, selectStatus);

      const transitions: string[] = [];
      statusFeed.subscribe(() => {
        transitions.push(statusFeed.getSnapshot());
      });

      let state = initial();
      const facts: Fact[] = [
        // Subscribe to gossip first
        {
          type: "gossip-subscribed",
          ts: 100,
        },
        // Receive a gossip message — triggers
        // activity = "receiving"
        {
          type: "gossip-message",
          ts: 200,
        },
      ];

      for (const fact of facts) {
        state = reduce(state, fact);
        docStateFeed._update(state);
      }

      // gossip-subscribed → "connecting"
      // gossip-message → "receiving"
      expect(transitions).toEqual(["connecting", "receiving"]);
    },
  );
});

describe("status dedup suppression", () => {
  it(
    "duplicate sync-status-changed connected " + "fires only one notification",
    () => {
      const docStateFeed = createFeed(initial());
      const statusFeed = projectFeed(docStateFeed, selectStatus);

      const transitions: string[] = [];
      statusFeed.subscribe(() => {
        transitions.push(statusFeed.getSnapshot());
      });

      let state = initial();
      const facts: Fact[] = [
        {
          type: "sync-status-changed",
          ts: 100,
          status: "connected" as const,
        },
        // Second identical fact — should be
        // suppressed by projectFeed equality dedup
        {
          type: "sync-status-changed",
          ts: 200,
          status: "connected" as const,
        },
      ];

      for (const fact of facts) {
        state = reduce(state, fact);
        docStateFeed._update(state);
      }

      // Only one "synced" notification despite
      // two connected facts
      expect(transitions).toEqual(["synced"]);
    },
  );
});

describe("awareness-only edge case (#224)", () => {
  it(
    "awareness connected + gossip subscribed " +
      "without sync returns connecting",
    () => {
      const docStateFeed = createFeed(initial());
      const statusFeed = projectFeed(docStateFeed, selectStatus);

      const transitions: string[] = [];
      statusFeed.subscribe(() => {
        transitions.push(statusFeed.getSnapshot());
      });

      let state = initial();
      const facts: Fact[] = [
        // Subscribe to gossip
        {
          type: "gossip-subscribed",
          ts: 100,
        },
        // Awareness connects (but sync is still
        // disconnected)
        {
          type: "awareness-status-changed",
          ts: 200,
          connected: true,
        },
      ];

      for (const fact of facts) {
        state = reduce(state, fact);
        docStateFeed._update(state);
      }

      // Both should be "connecting" — awareness
      // alone does NOT produce "receiving" (#224)
      expect(transitions).toEqual([
        "connecting",
        // Second fact doesn't change status
        // (still "connecting"), so projectFeed
        // dedup suppresses it
      ]);
      expect(statusFeed.getSnapshot()).toBe("connecting");
    },
  );
});

describe("saveState subscription transitions", () => {
  it(
    "unpublished → dirty → saving → saved " + "produces correct transitions",
    () => {
      const docStateFeed = createFeed(initial());
      const saveStateFeed = projectFeed(docStateFeed, selectSaveState);

      const transitions: string[] = [];
      saveStateFeed.subscribe(() => {
        transitions.push(saveStateFeed.getSnapshot());
      });

      // Initial is "unpublished"
      expect(saveStateFeed.getSnapshot()).toBe("unpublished");

      let state = initial();
      const facts: Fact[] = [
        {
          type: "content-dirty",
          ts: 100,
          clockSum: 1,
        },
        { type: "publish-started", ts: 200 },
        {
          type: "publish-succeeded",
          ts: 300,
          cid: cidPool[0]!,
          seq: 1,
        },
        // tip-advanced makes chain.tip non-null
        // so deriveSaveState returns "saved"
        {
          type: "cid-discovered",
          ts: 290,
          cid: cidPool[0]!,
          source: "gossipsub" as const,
          seq: 1,
        },
        {
          type: "tip-advanced",
          ts: 310,
          cid: cidPool[0]!,
          seq: 1,
        },
      ];

      for (const fact of facts) {
        state = reduce(state, fact);
        docStateFeed._update(state);
      }

      expect(transitions).toEqual([
        "dirty",
        "saving",
        "unpublished", // publish-succeeded clears dirty
        // but chain.tip is null → unpublished
        "saved", // tip-advanced sets chain.tip
      ]);
    },
  );

  it(
    "save error → dirty → saving → saved " + "produces correct transitions",
    () => {
      const docStateFeed = createFeed(initial());
      const saveStateFeed = projectFeed(docStateFeed, selectSaveState);

      const transitions: string[] = [];
      saveStateFeed.subscribe(() => {
        transitions.push(saveStateFeed.getSnapshot());
      });

      let state = initial();
      const facts: Fact[] = [
        {
          type: "content-dirty",
          ts: 100,
          clockSum: 1,
        },
        { type: "publish-started", ts: 200 },
        {
          type: "publish-failed",
          ts: 300,
          error: "timeout",
        },
      ];

      for (const fact of facts) {
        state = reduce(state, fact);
        docStateFeed._update(state);
      }

      expect(transitions).toEqual(["dirty", "saving", "save-error"]);
    },
  );
});
