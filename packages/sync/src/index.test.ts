import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { createSubdocManager } from "@pokapali/subdocs";
import {
  setupNamespaceRooms,
  setupAwarenessRoom,
} from "./index.js";

// Track mock provider instances globally
const mockProviderInstances: Array<{
  roomName: string;
  doc: Y.Doc;
  signaling: string[];
  password: string | null;
  awareness: Awareness;
  shouldConnect: boolean;
  room: object | null;
  destroyed: boolean;
  destroy(): void;
  readonly connected: boolean;
}> = [];

vi.mock("y-webrtc", () => {
  class MockProvider {
    roomName: string;
    doc: Y.Doc;
    signaling: string[];
    password: string | null;
    awareness: Awareness;
    shouldConnect = true;
    room: object | null = {};
    destroyed = false;

    constructor(
      roomName: string,
      doc: Y.Doc,
      opts: {
        signaling?: string[];
        password?: string | null;
      } = {}
    ) {
      this.roomName = roomName;
      this.doc = doc;
      this.signaling = opts.signaling ?? [];
      this.password = opts.password ?? null;
      this.awareness = new Awareness(doc);
      mockProviderInstances.push(this);
    }

    get connected() {
      return this.room !== null && this.shouldConnect;
    }

    destroy() {
      this.destroyed = true;
      this.shouldConnect = false;
      this.room = null;
    }
  }

  return { WebrtcProvider: MockProvider };
});

const SIGNALING = ["wss://test.example.com"];
const IPNS = "k51testipnsname";

function makeKey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

beforeEach(() => {
  mockProviderInstances.length = 0;
});

describe("setupNamespaceRooms", () => {
  it(
    "creates a provider per namespace + _meta",
    async () => {
      const keys: Record<string, Uint8Array> = {
        content: makeKey(1),
        comments: makeKey(2),
      };
      const mgr = createSubdocManager(
        IPNS, ["content", "comments"]
      );

      const sync = await setupNamespaceRooms(
        IPNS, mgr, keys, SIGNALING
      );

      // 2 namespaces + 1 _meta = 3 providers
      expect(mockProviderInstances).toHaveLength(3);

      const names = mockProviderInstances.map(
        (p) => p.roomName
      );
      expect(names).toContain(`${IPNS}:content`);
      expect(names).toContain(`${IPNS}:comments`);
      expect(names).toContain(`${IPNS}:_meta`);

      for (const p of mockProviderInstances) {
        expect(p.signaling).toEqual(SIGNALING);
      }

      // Namespace providers use hex passwords
      const cp = mockProviderInstances.find(
        (p) => p.roomName === `${IPNS}:content`
      )!;
      expect(cp.password).toBe(
        bytesToHex(keys.content)
      );

      const cmp = mockProviderInstances.find(
        (p) => p.roomName === `${IPNS}:comments`
      )!;
      expect(cmp.password).toBe(
        bytesToHex(keys.comments)
      );

      // _meta password is derived, not raw hex
      const mp = mockProviderInstances.find(
        (p) => p.roomName === `${IPNS}:_meta`
      )!;
      expect(mp.password).toBeTruthy();
      expect(mp.password).not.toBe(
        bytesToHex(keys.content)
      );

      expect(sync.status).toBe("connected");

      sync.destroy();
      mgr.destroy();
    }
  );

  it(
    "uses correct subdocs for each provider",
    async () => {
      const keys: Record<string, Uint8Array> = {
        content: makeKey(1),
      };
      const mgr = createSubdocManager(
        IPNS, ["content"]
      );

      await setupNamespaceRooms(
        IPNS, mgr, keys, SIGNALING
      );

      const cp = mockProviderInstances.find(
        (p) => p.roomName === `${IPNS}:content`
      )!;
      expect(cp.doc).toBe(mgr.subdoc("content"));

      const mp = mockProviderInstances.find(
        (p) => p.roomName === `${IPNS}:_meta`
      )!;
      expect(mp.doc).toBe(mgr.metaDoc);

      mgr.destroy();
    }
  );

  it(
    "returns disconnected for empty keys",
    async () => {
      const mgr = createSubdocManager(
        IPNS, ["content"]
      );
      const sync = await setupNamespaceRooms(
        IPNS, mgr, {}, SIGNALING
      );

      expect(sync.status).toBe("disconnected");
      expect(mockProviderInstances).toHaveLength(0);

      sync.destroy();
      mgr.destroy();
    }
  );

  it(
    "throws for missing primary namespace key",
    async () => {
      const keys: Record<string, Uint8Array> = {
        comments: makeKey(2),
      };
      const mgr = createSubdocManager(
        IPNS, ["content", "comments"]
      );

      await expect(
        setupNamespaceRooms(
          IPNS, mgr, keys, SIGNALING,
          { primaryNamespace: "content" }
        )
      ).rejects.toThrow(/Primary namespace/);

      mgr.destroy();
    }
  );

  it("aggregates status correctly", async () => {
    const keys: Record<string, Uint8Array> = {
      content: makeKey(1),
    };
    const mgr = createSubdocManager(
      IPNS, ["content"]
    );

    const sync = await setupNamespaceRooms(
      IPNS, mgr, keys, SIGNALING
    );

    expect(sync.status).toBe("connected");

    // Disconnect one, other still connected
    mockProviderInstances[0].shouldConnect = false;
    mockProviderInstances[0].room = null;
    expect(sync.status).toBe("connected");

    // Disconnect all
    for (const p of mockProviderInstances) {
      p.shouldConnect = false;
      p.room = null;
    }
    expect(sync.status).toBe("disconnected");

    sync.destroy();
    mgr.destroy();
  });

  it("destroy tears down all providers", async () => {
    const keys: Record<string, Uint8Array> = {
      content: makeKey(1),
      comments: makeKey(2),
    };
    const mgr = createSubdocManager(
      IPNS, ["content", "comments"]
    );

    const sync = await setupNamespaceRooms(
      IPNS, mgr, keys, SIGNALING
    );
    const before = [...mockProviderInstances];

    sync.destroy();

    for (const p of before) {
      expect(p.destroyed).toBe(true);
    }
    expect(sync.status).toBe("disconnected");

    mgr.destroy();
  });

  it(
    "meta password is deterministic",
    async () => {
      const keys: Record<string, Uint8Array> = {
        content: makeKey(1),
      };
      const mgr1 = createSubdocManager(
        IPNS, ["content"]
      );
      const mgr2 = createSubdocManager(
        IPNS, ["content"]
      );

      await setupNamespaceRooms(
        IPNS, mgr1, keys, SIGNALING
      );
      const meta1 = mockProviderInstances.find(
        (p) => p.roomName === `${IPNS}:_meta`
      )!;

      await setupNamespaceRooms(
        IPNS, mgr2, keys, SIGNALING
      );
      const metas = mockProviderInstances.filter(
        (p) => p.roomName === `${IPNS}:_meta`
      );
      const meta2 = metas[metas.length - 1];

      expect(meta1.password).toBe(meta2.password);

      mgr1.destroy();
      mgr2.destroy();
    }
  );
});

describe("setupAwarenessRoom", () => {
  it("creates a provider on a dummy doc", () => {
    const room = setupAwarenessRoom(
      IPNS, "abcdef", SIGNALING
    );

    expect(mockProviderInstances).toHaveLength(1);
    const p = mockProviderInstances[0];

    expect(p.roomName).toBe(`${IPNS}:awareness`);
    expect(p.password).toBe("abcdef");
    expect(p.signaling).toEqual(SIGNALING);
    expect(room.awareness).toBeInstanceOf(Awareness);

    room.destroy();
  });

  it("destroy tears down provider", () => {
    const room = setupAwarenessRoom(
      IPNS, "abcdef", SIGNALING
    );
    const p = mockProviderInstances[0];

    room.destroy();

    expect(p.destroyed).toBe(true);
  });
});
