import { describe, it, expect } from "vitest";
import { setupNamespaceRooms } from "./rooms.js";

const IPNS = "abc123";
const SIGNALING = ["ws://localhost:4444"];

function makeKey(seed: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = seed;
  return buf;
}

describe("setupNamespaceRooms", () => {
  it("creates no providers", () => {
    const keys: Record<string, Uint8Array> = {
      content: makeKey(1),
      comments: makeKey(2),
    };

    const sync = setupNamespaceRooms(IPNS, keys, SIGNALING);
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
