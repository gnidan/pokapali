import { describe, it, expect } from "vitest";
import { deriveDocKeys } from "@pokapali/crypto";
import {
  encodeFragment,
  decodeFragment,
  inferCapability,
  buildUrl,
  parseUrl,
  narrowCapability,
  type CapabilityKeys,
} from "./index.js";

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

async function makeFullKeys(): Promise<CapabilityKeys> {
  const doc = await deriveDocKeys("test-secret", "test-app", [
    "content",
    "comments",
  ]);
  return {
    readKey: doc.readKey,
    ipnsKeyBytes: doc.ipnsKeyBytes,
    rotationKey: doc.rotationKey,
    awarenessRoomPassword: doc.awarenessRoomPassword,
    channelKeys: doc.channelKeys,
  };
}

describe("encodeFragment / decodeFragment", () => {
  it("round-trips full keys", async () => {
    const keys = await makeFullKeys();
    const fragment = await encodeFragment(keys);
    const decoded = await decodeFragment(fragment);

    expect(
      arraysEqual(
        await exportKey(decoded.readKey!),
        await exportKey(keys.readKey!),
      ),
    ).toBe(true);
    expect(arraysEqual(decoded.ipnsKeyBytes!, keys.ipnsKeyBytes!)).toBe(true);
    expect(arraysEqual(decoded.rotationKey!, keys.rotationKey!)).toBe(true);
    expect(decoded.awarenessRoomPassword).toBe(keys.awarenessRoomPassword);
    expect(
      arraysEqual(
        decoded.channelKeys!["content"],
        keys.channelKeys!["content"],
      ),
    ).toBe(true);
    expect(
      arraysEqual(
        decoded.channelKeys!["comments"],
        keys.channelKeys!["comments"],
      ),
    ).toBe(true);
  });

  it("round-trips read-only keys", async () => {
    const full = await makeFullKeys();
    const readOnly: CapabilityKeys = {
      readKey: full.readKey,
      awarenessRoomPassword: full.awarenessRoomPassword,
    };
    const fragment = await encodeFragment(readOnly);
    const decoded = await decodeFragment(fragment);

    expect(
      arraysEqual(
        await exportKey(decoded.readKey!),
        await exportKey(readOnly.readKey!),
      ),
    ).toBe(true);
    expect(decoded.awarenessRoomPassword).toBe(readOnly.awarenessRoomPassword);
    expect(decoded.ipnsKeyBytes).toBeUndefined();
    expect(decoded.rotationKey).toBeUndefined();
    expect(decoded.channelKeys).toBeUndefined();
  });

  it("produces valid base64url", async () => {
    const keys = await makeFullKeys();
    const fragment = await encodeFragment(keys);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is deterministic", async () => {
    const keys = await makeFullKeys();
    const a = await encodeFragment(keys);
    const b = await encodeFragment(keys);
    expect(a).toBe(b);
  });

  it("entries are sorted by label", async () => {
    const keys = await makeFullKeys();
    const fragment = await encodeFragment(keys);
    const buf = base64urlDecode(fragment);
    const labels: string[] = [];
    let offset = 1;
    while (offset < buf.length) {
      const labelLen = buf[offset++];
      const label = new TextDecoder().decode(
        buf.slice(offset, offset + labelLen),
      );
      labels.push(label);
      offset += labelLen;
      const valueLen = buf[offset++];
      offset += valueLen;
    }
    const sorted = [...labels].sort();
    expect(labels).toEqual(sorted);
  });

  it("starts with version byte 0x00", async () => {
    const keys = await makeFullKeys();
    const fragment = await encodeFragment(keys);
    const buf = base64urlDecode(fragment);
    expect(buf[0]).toBe(0x00);
  });

  it("throws on unknown version", async () => {
    const buf = new Uint8Array([0xff]);
    const fragment = base64urlEncode(buf);
    await expect(decodeFragment(fragment)).rejects.toThrow(/version/i);
  });

  it("throws on empty fragment", async () => {
    await expect(decodeFragment("")).rejects.toThrow();
  });

  it("byte-exact test vector", async () => {
    // Construct known keys with fixed bytes
    const readKeyBytes = new Uint8Array(32).fill(0xaa);
    const readKey = await crypto.subtle.importKey(
      "raw",
      readKeyBytes as unknown as ArrayBuffer,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const keys: CapabilityKeys = {
      readKey,
      awarenessRoomPassword: "pw",
    };
    const fragment = await encodeFragment(keys);

    // Expected wire format:
    //   0x00 (version)
    //   0x01 "a" 0x02 "pw"  (awarenessRoomPassword)
    //   0x01 "r" 0x20 <32 bytes of 0xaa> (readKey)
    // Labels sorted: "a" < "r"
    const expected = new Uint8Array([
      0x00,
      0x01,
      0x61,
      0x02,
      0x70,
      0x77,
      0x01,
      0x72,
      0x20,
      ...new Uint8Array(32).fill(0xaa),
    ]);
    expect(fragment).toBe(base64urlEncode(expected));
  });

  it("round-trips writer keys (no rotationKey)", async () => {
    const full = await makeFullKeys();
    const writer: CapabilityKeys = {
      readKey: full.readKey,
      ipnsKeyBytes: full.ipnsKeyBytes,
      awarenessRoomPassword: full.awarenessRoomPassword,
      channelKeys: full.channelKeys,
    };
    const fragment = await encodeFragment(writer);
    const decoded = await decodeFragment(fragment);

    expect(
      arraysEqual(
        await exportKey(decoded.readKey!),
        await exportKey(writer.readKey!),
      ),
    ).toBe(true);
    expect(arraysEqual(decoded.ipnsKeyBytes!, writer.ipnsKeyBytes!)).toBe(true);
    expect(decoded.rotationKey).toBeUndefined();
    expect(decoded.awarenessRoomPassword).toBe(writer.awarenessRoomPassword);
    expect(
      arraysEqual(
        decoded.channelKeys!["content"],
        writer.channelKeys!["content"],
      ),
    ).toBe(true);
  });
});

describe("inferCapability", () => {
  it("full keys = admin", async () => {
    const keys = await makeFullKeys();
    const cap = inferCapability(keys, ["content", "comments"]);
    expect(cap.isAdmin).toBe(true);
    expect(cap.canPushSnapshots).toBe(true);
    expect(cap.channels).toEqual(new Set(["content", "comments"]));
  });

  it("read-only keys = no channels", async () => {
    const full = await makeFullKeys();
    const readOnly: CapabilityKeys = {
      readKey: full.readKey,
      awarenessRoomPassword: full.awarenessRoomPassword,
    };
    const cap = inferCapability(readOnly, ["content", "comments"]);
    expect(cap.isAdmin).toBe(false);
    expect(cap.canPushSnapshots).toBe(false);
    expect(cap.channels.size).toBe(0);
  });

  it("partial channel keys", async () => {
    const full = await makeFullKeys();
    const partial: CapabilityKeys = {
      readKey: full.readKey,
      awarenessRoomPassword: full.awarenessRoomPassword,
      channelKeys: {
        comments: full.channelKeys!["comments"],
      },
    };
    const cap = inferCapability(partial, ["content", "comments"]);
    expect(cap.channels).toEqual(new Set(["comments"]));
    expect(cap.canPushSnapshots).toBe(false);
  });

  it("writer role: canPushSnapshots, not admin", async () => {
    const full = await makeFullKeys();
    const writer: CapabilityKeys = {
      readKey: full.readKey,
      ipnsKeyBytes: full.ipnsKeyBytes,
      awarenessRoomPassword: full.awarenessRoomPassword,
      channelKeys: full.channelKeys,
    };
    const cap = inferCapability(writer, ["content", "comments"]);
    expect(cap.canPushSnapshots).toBe(true);
    expect(cap.isAdmin).toBe(false);
    expect(cap.channels).toEqual(new Set(["content", "comments"]));
  });

  it("ignores unknown channels", async () => {
    const full = await makeFullKeys();
    const cap = inferCapability(full, ["content"]);
    expect(cap.channels).toEqual(new Set(["content"]));
  });
});

describe("buildUrl / parseUrl", () => {
  it("round-trips", async () => {
    const keys = await makeFullKeys();
    const url = await buildUrl("https://myapp.com", "abc123", keys);
    expect(url).toContain("https://myapp.com/doc/abc123#");
    const parsed = await parseUrl(url);
    expect(parsed.base).toBe("https://myapp.com");
    expect(parsed.ipnsName).toBe("abc123");
    expect(
      arraysEqual(
        await exportKey(parsed.keys.readKey!),
        await exportKey(keys.readKey!),
      ),
    ).toBe(true);
  });

  it("handles trailing slash in base", async () => {
    const keys = await makeFullKeys();
    const url = await buildUrl("https://myapp.com/", "abc123", keys);
    expect(url).toContain("https://myapp.com/doc/abc123#");
    const parsed = await parseUrl(url);
    expect(parsed.base).toBe("https://myapp.com");
    expect(parsed.ipnsName).toBe("abc123");
  });

  it("throws on URL without fragment", async () => {
    await expect(parseUrl("https://myapp.com/doc/abc123")).rejects.toThrow(
      /fragment/i,
    );
  });

  it("throws on URL missing /doc/ segment", async () => {
    await expect(parseUrl("https://myapp.com/abc123#frag")).rejects.toThrow(
      /\/doc\//,
    );
  });
});

describe("narrowCapability", () => {
  it("narrows to subset of channels", async () => {
    const keys = await makeFullKeys();
    const narrowed = narrowCapability(keys, {
      channels: ["comments"],
    });
    expect(narrowed.readKey).toBeDefined();
    expect(narrowed.awarenessRoomPassword).toBeDefined();
    expect(narrowed.ipnsKeyBytes).toBeUndefined();
    expect(narrowed.rotationKey).toBeUndefined();
    expect(Object.keys(narrowed.channelKeys!)).toEqual(["comments"]);
  });

  it("includes ipnsKeyBytes when canPushSnapshots", async () => {
    const keys = await makeFullKeys();
    const narrowed = narrowCapability(keys, {
      channels: ["content"],
      canPushSnapshots: true,
    });
    expect(narrowed.ipnsKeyBytes).toBeDefined();
    expect(narrowed.rotationKey).toBeUndefined();
  });

  it("never includes rotationKey", async () => {
    const keys = await makeFullKeys();
    const narrowed = narrowCapability(keys, {
      channels: ["content", "comments"],
      canPushSnapshots: true,
    });
    expect(narrowed.rotationKey).toBeUndefined();
  });

  it("omits channelKeys if none granted", async () => {
    const keys = await makeFullKeys();
    const narrowed = narrowCapability(keys, {});
    expect(narrowed.channelKeys).toBeUndefined();
    expect(narrowed.readKey).toBeDefined();
  });

  it("throws on channel not in source keys", async () => {
    const keys = await makeFullKeys();
    expect(() =>
      narrowCapability(keys, {
        channels: ["nonexistent"],
      }),
    ).toThrow(/nonexistent/);
  });

  it("throws listing all missing channels", async () => {
    const keys = await makeFullKeys();
    expect(() =>
      narrowCapability(keys, {
        channels: ["content", "missing1", "missing2"],
      }),
    ).toThrow(/missing1.*missing2|missing2.*missing1/);
  });

  it(
    "throws when keys have no channelKeys " + "but grant requests channels",
    async () => {
      const full = await makeFullKeys();
      const readOnly: CapabilityKeys = {
        readKey: full.readKey,
        awarenessRoomPassword: full.awarenessRoomPassword,
      };
      expect(() =>
        narrowCapability(readOnly, {
          channels: ["content"],
        }),
      ).toThrow(/content/);
    },
  );

  it("narrows writer to channel subset", async () => {
    const full = await makeFullKeys();
    const writer: CapabilityKeys = {
      readKey: full.readKey,
      ipnsKeyBytes: full.ipnsKeyBytes,
      awarenessRoomPassword: full.awarenessRoomPassword,
      channelKeys: full.channelKeys,
    };
    const narrowed = narrowCapability(writer, {
      channels: ["comments"],
    });
    expect(narrowed.readKey).toBeDefined();
    expect(narrowed.awarenessRoomPassword).toBeDefined();
    expect(narrowed.ipnsKeyBytes).toBeUndefined();
    expect(narrowed.rotationKey).toBeUndefined();
    expect(Object.keys(narrowed.channelKeys!)).toEqual(["comments"]);
  });

  it("full narrow round-trip encode/decode", async () => {
    const keys = await makeFullKeys();
    const narrowed = narrowCapability(keys, {
      channels: ["comments"],
      canPushSnapshots: true,
    });
    const fragment = await encodeFragment(narrowed);
    const decoded = await decodeFragment(fragment);
    const cap = inferCapability(decoded, ["content", "comments"]);
    expect(cap.channels).toEqual(new Set(["comments"]));
    expect(cap.canPushSnapshots).toBe(true);
    expect(cap.isAdmin).toBe(false);
  });
});

// --- Helpers ---

function base64urlDecode(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(base64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function base64urlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
