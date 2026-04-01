import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
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
    connected = false;
    disconnected = false;
    destroyed = false;

    constructor(
      roomName: string,
      doc: Y.Doc,
      opts: {
        signaling: string[];
        password: string | null;
        awareness?: { states: Map<number, unknown> };
      },
    ) {
      this.roomName = roomName;
      this.doc = doc;
      this.signaling = opts.signaling;
      this.password = opts.password;
      this.awareness = opts.awareness ?? {
        states: new Map(),
      };
      instances.push(this);
    }

    on() {}
    off() {}

    disconnect() {
      this.disconnected = true;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  return { WebrtcProvider: MockProvider };
});

const IPNS = "abc123";
const SIGNALING = ["ws://localhost:4444"];

function makeKey(seed: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = seed;
  return buf;
}

describe("setupNamespaceRooms", () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it("creates no providers", () => {
    const keys: Record<string, Uint8Array> = {
      content: makeKey(1),
      comments: makeKey(2),
    };

    const sync = setupNamespaceRooms(IPNS, keys, SIGNALING);

    expect(instances).toHaveLength(0);
    sync.destroy();
  });

  it("status is always disconnected", () => {
    const sync = setupNamespaceRooms(IPNS, { content: makeKey(1) }, SIGNALING);

    expect(sync.status).toBe("disconnected");
    sync.destroy();
  });

  it("destroy is safe to call multiple times", () => {
    const sync = setupNamespaceRooms(IPNS, { content: makeKey(1) }, SIGNALING);

    expect(() => {
      sync.destroy();
      sync.destroy();
    }).not.toThrow();
  });
});

describe("setupAwarenessRoom", () => {
  it("returns an AwarenessRoom", () => {
    const room = setupAwarenessRoom(IPNS, "test-password", SIGNALING);
    expect(room.awareness).toBeDefined();
    expect(room.connected).toBe(false);
    room.destroy();
  });
});
