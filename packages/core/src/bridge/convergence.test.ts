import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import type { SubdocManager } from "@pokapali/subdocs";
import { createDocument } from "../document/document.js";
import type { Document } from "../document/document.js";
import { createConvergenceDetector } from "./convergence.js";

// -- Helpers --

function fakeIdentity() {
  return {
    publicKey: new Uint8Array(32).fill(0xaa),
    privateKey: new Uint8Array(64).fill(0xbb),
  };
}

function fakeCapability() {
  return {
    channels: new Set(["content", "comments"]),
    canPushSnapshots: false,
    isAdmin: false,
  };
}

/**
 * Minimal mock Awareness that tracks local state
 * fields and simulates peer states.
 */
function mockAwareness() {
  const localState: Record<string, unknown> = {};
  const states = new Map<number, Record<string, unknown>>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  // Local peer is clientID 1
  states.set(1, localState);

  const awareness = {
    clientID: 1,

    setLocalStateField(field: string, value: unknown) {
      localState[field] = value;
      states.set(1, { ...localState });
      // Fire change event
      const cbs = listeners.get("change");
      if (cbs) {
        for (const cb of cbs) cb();
      }
    },

    getLocalState() {
      return localState;
    },

    getStates() {
      return states;
    },

    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },

    off(event: string, cb: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(cb);
    },

    // Test helper: add a peer with matching state
    _addPeer(clientId: number, state: Record<string, unknown>) {
      states.set(clientId, state);
    },

    // Test helper: remove peer
    _removePeer(clientId: number) {
      states.delete(clientId);
    },
  };

  return awareness;
}

function mockSubdocManager(channelNames: string[]): {
  manager: SubdocManager;
  docs: Map<string, Y.Doc>;
} {
  const docs = new Map<string, Y.Doc>();
  for (const name of channelNames) {
    docs.set(name, new Y.Doc());
  }

  const manager: SubdocManager = {
    subdoc(ns: string): Y.Doc {
      let doc = docs.get(ns);
      if (!doc) {
        doc = new Y.Doc();
        docs.set(ns, doc);
      }
      return doc;
    },
    get metaDoc(): Y.Doc {
      return new Y.Doc();
    },
    encodeAll() {
      return {};
    },
    applySnapshot() {},
    get isDirty() {
      return false;
    },
    on() {},
    off() {},
    whenLoaded: Promise.resolve(),
    destroy() {},
  };

  return { manager, docs };
}

// -- Tests --

describe("createConvergenceDetector", () => {
  let doc: Document;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hash match increments count toward threshold", () => {
    const awareness = mockAwareness();
    const { manager } = mockSubdocManager(["content"]);

    const detector = createConvergenceDetector({
      awareness,
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      hysteresisCount: 3,
      checkIntervalMs: 1000,
    });

    // Add peer 2 with same state (empty doc)
    // After first tick, local sets its hash
    vi.advanceTimersByTime(1000);

    // Copy local hash to peer
    const localState = awareness.getLocalState();
    awareness._addPeer(2, { ...localState });

    // Tick 2 — hashes match, count = 1
    vi.advanceTimersByTime(1000);
    // Tick 3 — count = 2
    vi.advanceTimersByTime(1000);

    // Not yet at threshold 3 — no closeEpoch
    const epochs = toArray(doc.channel("content").tree);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.boundary.tag).toBe("open");

    detector.destroy();
  });

  it("hash change resets count", () => {
    const awareness = mockAwareness();
    const { manager, docs } = mockSubdocManager(["content"]);

    const detector = createConvergenceDetector({
      awareness,
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      hysteresisCount: 3,
      checkIntervalMs: 1000,
    });

    // Tick 1 — set initial hash
    vi.advanceTimersByTime(1000);
    const localState = awareness.getLocalState();
    awareness._addPeer(2, { ...localState });

    // Tick 2 — match, count = 1
    vi.advanceTimersByTime(1000);

    // Change the doc (hash changes)
    docs.get("content")!.getArray("data").push([42]);

    // Tick 3 — hash changed, count resets
    vi.advanceTimersByTime(1000);

    // Copy new hash to peer
    const newState = awareness.getLocalState();
    awareness._addPeer(2, { ...newState });

    // Ticks 4, 5 — match, count = 1, 2
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    // Still no closeEpoch (count reset, only at 2)
    const epochs = toArray(doc.channel("content").tree);
    expect(epochs).toHaveLength(1);

    detector.destroy();
  });

  it("threshold reached triggers closeEpoch", () => {
    const awareness = mockAwareness();
    const { manager } = mockSubdocManager(["content"]);

    const detector = createConvergenceDetector({
      awareness,
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      hysteresisCount: 3,
      checkIntervalMs: 1000,
    });

    // Tick 1 — set hash
    vi.advanceTimersByTime(1000);
    const localState = awareness.getLocalState();
    awareness._addPeer(2, { ...localState });

    // Ticks 2, 3, 4 — match 3 times → closeEpoch
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    const epochs = toArray(doc.channel("content").tree);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.boundary.tag).toBe("closed");
    expect(epochs[1]!.boundary.tag).toBe("open");

    detector.destroy();
  });

  it("per-channel independence", () => {
    const awareness = mockAwareness();
    const { manager, docs } = mockSubdocManager(["content", "comments"]);

    const detector = createConvergenceDetector({
      awareness,
      document: doc,
      subdocManager: manager,
      channelNames: ["content", "comments"],
      hysteresisCount: 2,
      checkIntervalMs: 1000,
    });

    // Tick 1 — set hashes
    vi.advanceTimersByTime(1000);
    const localState = awareness.getLocalState();
    awareness._addPeer(2, { ...localState });

    // Tick 2 — both match, count = 1
    vi.advanceTimersByTime(1000);

    // Modify content only
    docs.get("content")!.getArray("data").push([1]);

    // Tick 3 — content hash changed (reset),
    //          comments still matching (count = 2 → close)
    vi.advanceTimersByTime(1000);

    // Comments should have closed epoch
    const commentsEpochs = toArray(doc.channel("comments").tree);
    expect(commentsEpochs.length).toBeGreaterThanOrEqual(2);
    expect(commentsEpochs[0]!.boundary.tag).toBe("closed");

    // Content should NOT have closed (hash changed)
    const contentEpochs = toArray(doc.channel("content").tree);
    expect(contentEpochs).toHaveLength(1);

    detector.destroy();
  });

  it("single peer — no convergence", () => {
    const awareness = mockAwareness();
    const { manager } = mockSubdocManager(["content"]);

    const detector = createConvergenceDetector({
      awareness,
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      hysteresisCount: 2,
      checkIntervalMs: 1000,
    });

    // Ticks with only 1 peer (local) — no convergence
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    const epochs = toArray(doc.channel("content").tree);
    expect(epochs).toHaveLength(1);

    detector.destroy();
  });

  it(
    "peer leaving mid-hysteresis — count " +
      "continues (not reset by peer gap)",
    () => {
      const awareness = mockAwareness();
      const { manager } = mockSubdocManager(["content"]);

      const detector = createConvergenceDetector({
        awareness,
        document: doc,
        subdocManager: manager,
        channelNames: ["content"],
        hysteresisCount: 3,
        checkIntervalMs: 1000,
      });

      // Tick 1 — set hash
      vi.advanceTimersByTime(1000);
      const localState = awareness.getLocalState();
      awareness._addPeer(2, { ...localState });

      // Tick 2 — match, count = 1
      vi.advanceTimersByTime(1000);

      // Peer leaves (tab close)
      awareness._removePeer(2);

      // Tick 3 — only 1 peer, check skipped
      // (count stays at 1, not incremented)
      vi.advanceTimersByTime(1000);

      // Peer rejoins with same hash
      awareness._addPeer(2, {
        ...awareness.getLocalState(),
      });

      // Tick 4 — match, count = 2
      vi.advanceTimersByTime(1000);

      // Not yet at 3
      let epochs = toArray(doc.channel("content").tree);
      expect(epochs).toHaveLength(1);

      // Tick 5 — match, count = 3 → closeEpoch
      vi.advanceTimersByTime(1000);

      epochs = toArray(doc.channel("content").tree);
      expect(epochs).toHaveLength(2);
      expect(epochs[0]!.boundary.tag).toBe("closed");

      detector.destroy();
    },
  );

  it("3+ peers — partial match prevents " + "convergence", () => {
    const awareness = mockAwareness();
    const { manager, docs } = mockSubdocManager(["content"]);

    const detector = createConvergenceDetector({
      awareness,
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      hysteresisCount: 2,
      checkIntervalMs: 1000,
    });

    // Tick 1 — set hash
    vi.advanceTimersByTime(1000);
    const localState = awareness.getLocalState();

    // Peer 2 matches, peer 3 has different doc
    awareness._addPeer(2, { ...localState });

    // Peer 3 has a different hash (different doc)
    const peerDoc = new Y.Doc();
    peerDoc.getArray("data").push([99]);
    // Compute a different hash manually
    awareness._addPeer(3, {
      "svHash:content": "deadbeefdeadbeef",
    });

    // Ticks 2, 3, 4 — peer 3 never matches
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    // No convergence — not all peers match
    const epochs = toArray(doc.channel("content").tree);
    expect(epochs).toHaveLength(1);

    detector.destroy();
  });

  it("destroy stops timer", () => {
    const awareness = mockAwareness();
    const { manager } = mockSubdocManager(["content"]);

    const detector = createConvergenceDetector({
      awareness,
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      hysteresisCount: 2,
      checkIntervalMs: 1000,
    });

    // Tick 1
    vi.advanceTimersByTime(1000);
    const localState = awareness.getLocalState();
    awareness._addPeer(2, { ...localState });

    detector.destroy();

    // More ticks should not cause convergence
    vi.advanceTimersByTime(10000);

    const epochs = toArray(doc.channel("content").tree);
    expect(epochs).toHaveLength(1);
  });
});
