import { describe, it, expect } from "vitest";
import { Capability } from "./capability.js";
import type { Credential } from "../credential.js";

// -- Helpers --

function fullCredential(): Credential {
  return {
    channelKeys: {
      content: new Uint8Array([1]),
      comments: new Uint8Array([2]),
      metadata: new Uint8Array([3]),
    },
    ipnsKeyBytes: new Uint8Array([10]),
    rotationKey: new Uint8Array([20]),
    awarenessRoomPassword: "secret",
  };
}

// -- Capability.infer --

describe("Capability.infer", () => {
  it(
    "returns writable channels present in both credential " +
      "and channel list",
    () => {
      const cred = fullCredential();
      const cap = Capability.infer(cred, ["content", "comments", "unknown"]);
      expect(cap.channels).toEqual(new Set(["content", "comments"]));
    },
  );

  it("sets canPushSnapshots when ipnsKeyBytes present", () => {
    const cred = fullCredential();
    expect(Capability.infer(cred, []).canPushSnapshots).toBe(true);
  });

  it("sets canPushSnapshots false when ipnsKeyBytes " + "missing", () => {
    const cred: Credential = {};
    expect(Capability.infer(cred, []).canPushSnapshots).toBe(false);
  });

  it("sets isAdmin when rotationKey present", () => {
    const cred = fullCredential();
    expect(Capability.infer(cred, []).isAdmin).toBe(true);
  });

  it("sets isAdmin false when rotationKey missing", () => {
    const cred: Credential = {};
    expect(Capability.infer(cred, []).isAdmin).toBe(false);
  });

  it("returns empty channels when credential has no " + "channelKeys", () => {
    const cred: Credential = {};
    const cap = Capability.infer(cred, ["content", "comments"]);
    expect(cap.channels.size).toBe(0);
  });
});

// -- Capability.narrow --

describe("Capability.narrow", () => {
  it("always preserves awarenessRoomPassword", () => {
    const cred = fullCredential();
    const narrowed = Capability.narrow(cred, { channels: [] });
    expect(narrowed.awarenessRoomPassword).toBe("secret");
  });

  it("never includes rotationKey", () => {
    const cred = fullCredential();
    const narrowed = Capability.narrow(cred, {});
    expect(narrowed.rotationKey).toBeUndefined();
  });

  it("includes ipnsKeyBytes only when grant allows", () => {
    const cred = fullCredential();
    const without = Capability.narrow(cred, {});
    expect(without.ipnsKeyBytes).toBeUndefined();

    const with_ = Capability.narrow(cred, {
      canPushSnapshots: true,
    });
    expect(with_.ipnsKeyBytes).toEqual(new Uint8Array([10]));
  });

  it("preserves all channels when grant.channels " + "is undefined", () => {
    const cred = fullCredential();
    const narrowed = Capability.narrow(cred, {});
    expect(narrowed.channelKeys).toEqual({
      content: new Uint8Array([1]),
      comments: new Uint8Array([2]),
      metadata: new Uint8Array([3]),
    });
  });

  it("removes all channels when grant.channels " + "is empty", () => {
    const cred = fullCredential();
    const narrowed = Capability.narrow(cred, { channels: [] });
    expect(narrowed.channelKeys).toBeUndefined();
  });

  it("narrows to specified channels", () => {
    const cred = fullCredential();
    const narrowed = Capability.narrow(cred, {
      channels: ["content"],
    });
    expect(narrowed.channelKeys).toEqual({
      content: new Uint8Array([1]),
    });
  });

  it("throws when grant requests missing channels", () => {
    const cred = fullCredential();
    expect(() =>
      Capability.narrow(cred, {
        channels: ["nonexistent"],
      }),
    ).toThrow(/not in source/);
  });
});
