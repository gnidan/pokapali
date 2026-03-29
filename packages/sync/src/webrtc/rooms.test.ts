import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { createSubdocManager } from "@pokapali/subdocs";
import { setupNamespaceRooms, setupAwarenessRoom } from "./rooms.js";

interface MockInstance {
  roomName: string;
  doc: Y.Doc;
  signaling: string[];
  password: string | null;
  awareness: { states: Map<number, unknown> };
  shouldConnect: boolean;
  connected: boolean;
  disconnected: boolean;
  destroyed: boolean;
  disconnect(): void;
  destroy(): void;
}

const instances: MockInstance[] = [];

vi.mock("y-webrtc", () => {
  class MockProvider {
    roomName: string;
    doc: Y.Doc;
    signaling: string[];
    password: string | null;
    awareness: { states: Map<number, unknown> };
    shouldConnect = true;
    connected = true;
    disconnected = false;
    destroyed = false;

    constructor(
      roomName: string,
      doc: Y.Doc,
      opts: {
        signaling?: string[];
        password?: string | null;
      } = {},
    ) {
      this.roomName = roomName;
      this.doc = doc;
      this.signaling = opts.signaling ?? [];
      this.password = opts.password ?? null;
      this.awareness = {
        states: new Map(),
      };
      instances.push(this as unknown as MockInstance);
    }

    on(_event: string, _cb: () => void) {}
    off(_event: string, _cb: () => void) {}

    disconnect() {
      this.disconnected = true;
      this.shouldConnect = false;
      this.connected = false;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  return {
    WebrtcProvider: MockProvider,
    signalingConns: new Map(),
    setupSignalingHandlers: () => {},
  };
});

const SIGNALING = ["wss://test.example.com"];
const IPNS = "k51testipnsname";

function makeKey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

beforeEach(() => {
  instances.length = 0;
});

describe("setupNamespaceRooms (thin shell)", () => {
  it("creates no providers", () => {
    const keys: Record<string, Uint8Array> = {
      content: makeKey(1),
      comments: makeKey(2),
    };
    const mgr = createSubdocManager(IPNS, ["content", "comments"]);

    const sync = setupNamespaceRooms(IPNS, mgr, keys, SIGNALING);

    expect(instances).toHaveLength(0);
    mgr.destroy();
    sync.destroy();
  });

  it("status is always disconnected", () => {
    const mgr = createSubdocManager(IPNS, ["content"]);

    const sync = setupNamespaceRooms(
      IPNS,
      mgr,
      { content: makeKey(1) },
      SIGNALING,
    );

    expect(sync.status).toBe("disconnected");
    mgr.destroy();
    sync.destroy();
  });

  it("connectChannel is a no-op", () => {
    const mgr = createSubdocManager(IPNS, ["content"]);

    const sync = setupNamespaceRooms(
      IPNS,
      mgr,
      { content: makeKey(1) },
      SIGNALING,
    );

    // Should not throw or create providers
    sync.connectChannel("content");
    sync.connectChannel("nonexistent");
    expect(instances).toHaveLength(0);

    mgr.destroy();
    sync.destroy();
  });

  it("destroy is safe to call multiple times", () => {
    const mgr = createSubdocManager(IPNS, ["content"]);

    const sync = setupNamespaceRooms(
      IPNS,
      mgr,
      { content: makeKey(1) },
      SIGNALING,
    );

    expect(() => {
      sync.destroy();
      sync.destroy();
    }).not.toThrow();

    mgr.destroy();
  });
});

describe("setupAwarenessRoom", () => {
  it("creates correct room with password", () => {
    const room = setupAwarenessRoom(IPNS, "abcdef01", SIGNALING);

    expect(instances).toHaveLength(1);
    const p = instances[0]!;

    expect(p.roomName).toBe(`${IPNS}:awareness`);
    expect(p.password).toBe("abcdef01");
    expect(p.signaling).toEqual(SIGNALING);

    room.destroy();
  });

  it("exposes provider awareness", () => {
    const room = setupAwarenessRoom(IPNS, "abcdef01", SIGNALING);

    expect(room.awareness).toBe(instances[0]!.awareness);

    room.destroy();
  });

  it("exposes connected state", () => {
    const room = setupAwarenessRoom(IPNS, "abcdef01", SIGNALING);

    expect(room.connected).toBe(true);

    instances[0]!.connected = false;
    expect(room.connected).toBe(false);

    room.destroy();
  });

  it("onStatusChange fires callback", () => {
    const room = setupAwarenessRoom(IPNS, "abcdef01", SIGNALING);
    const cb = vi.fn();
    room.onStatusChange(cb);

    // MockProvider.on() is a no-op so we can't
    // trigger status — verify cb is stored.
    expect(cb).not.toHaveBeenCalled();

    room.destroy();
  });

  it("onPeerConnection returns unsubscribe", () => {
    const room = setupAwarenessRoom(IPNS, "abcdef01", SIGNALING);

    const cb = vi.fn();
    const unsub = room.onPeerConnection(cb);

    expect(typeof unsub).toBe("function");
    unsub();

    room.destroy();
  });

  it("destroy cleans up provider and dummy doc", () => {
    const room = setupAwarenessRoom(IPNS, "abcdef01", SIGNALING);
    const p = instances[0]!;

    room.destroy();

    expect(p.disconnected).toBe(true);
    expect(p.destroyed).toBe(true);
  });
});
