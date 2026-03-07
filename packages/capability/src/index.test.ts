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

function arraysEqual(
  a: Uint8Array, b: Uint8Array
): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function exportKey(
  key: CryptoKey
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.exportKey("raw", key)
  );
}

async function makeFullKeys(): Promise<CapabilityKeys> {
  const doc = await deriveDocKeys(
    "test-secret", "test-app",
    ["content", "comments"]
  );
  return {
    readKey: doc.readKey,
    ipnsKeyBytes: doc.ipnsKeyBytes,
    rotationKey: doc.rotationKey,
    awarenessRoomPassword: doc.awarenessRoomPassword,
    namespaceKeys: doc.namespaceKeys,
  };
}

describe("encodeFragment / decodeFragment", () => {
  it("round-trips full keys", async () => {
    const keys = await makeFullKeys();
    const fragment = await encodeFragment(keys);
    const decoded = await decodeFragment(fragment);

    expect(arraysEqual(
      await exportKey(decoded.readKey!),
      await exportKey(keys.readKey!)
    )).toBe(true);
    expect(arraysEqual(
      decoded.ipnsKeyBytes!, keys.ipnsKeyBytes!
    )).toBe(true);
    expect(arraysEqual(
      decoded.rotationKey!, keys.rotationKey!
    )).toBe(true);
    expect(decoded.awarenessRoomPassword)
      .toBe(keys.awarenessRoomPassword);
    expect(arraysEqual(
      decoded.namespaceKeys!["content"],
      keys.namespaceKeys!["content"]
    )).toBe(true);
    expect(arraysEqual(
      decoded.namespaceKeys!["comments"],
      keys.namespaceKeys!["comments"]
    )).toBe(true);
  });

  it("round-trips read-only keys", async () => {
    const full = await makeFullKeys();
    const readOnly: CapabilityKeys = {
      readKey: full.readKey,
      awarenessRoomPassword:
        full.awarenessRoomPassword,
    };
    const fragment = await encodeFragment(readOnly);
    const decoded = await decodeFragment(fragment);

    expect(arraysEqual(
      await exportKey(decoded.readKey!),
      await exportKey(readOnly.readKey!)
    )).toBe(true);
    expect(decoded.awarenessRoomPassword)
      .toBe(readOnly.awarenessRoomPassword);
    expect(decoded.ipnsKeyBytes).toBeUndefined();
    expect(decoded.rotationKey).toBeUndefined();
    expect(decoded.namespaceKeys).toBeUndefined();
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
        buf.slice(offset, offset + labelLen)
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
    await expect(decodeFragment(fragment))
      .rejects.toThrow(/version/i);
  });

  it("throws on empty fragment", async () => {
    await expect(decodeFragment(""))
      .rejects.toThrow();
  });
});

describe("inferCapability", () => {
  it("full keys = admin", async () => {
    const keys = await makeFullKeys();
    const cap = inferCapability(
      keys, ["content", "comments"]
    );
    expect(cap.isAdmin).toBe(true);
    expect(cap.canPushSnapshots).toBe(true);
    expect(cap.namespaces).toEqual(
      new Set(["content", "comments"])
    );
  });

  it("read-only keys = no namespaces", async () => {
    const full = await makeFullKeys();
    const readOnly: CapabilityKeys = {
      readKey: full.readKey,
      awarenessRoomPassword:
        full.awarenessRoomPassword,
    };
    const cap = inferCapability(
      readOnly, ["content", "comments"]
    );
    expect(cap.isAdmin).toBe(false);
    expect(cap.canPushSnapshots).toBe(false);
    expect(cap.namespaces.size).toBe(0);
  });

  it("partial namespace keys", async () => {
    const full = await makeFullKeys();
    const partial: CapabilityKeys = {
      readKey: full.readKey,
      awarenessRoomPassword:
        full.awarenessRoomPassword,
      namespaceKeys: {
        comments: full.namespaceKeys!["comments"],
      },
    };
    const cap = inferCapability(
      partial, ["content", "comments"]
    );
    expect(cap.namespaces).toEqual(
      new Set(["comments"])
    );
    expect(cap.canPushSnapshots).toBe(false);
  });

  it("ignores unknown namespaces", async () => {
    const full = await makeFullKeys();
    const cap = inferCapability(full, ["content"]);
    expect(cap.namespaces).toEqual(
      new Set(["content"])
    );
  });
});

describe("buildUrl / parseUrl", () => {
  it("round-trips", async () => {
    const keys = await makeFullKeys();
    const url = await buildUrl(
      "https://myapp.com/doc", "abc123", keys
    );
    const parsed = await parseUrl(url);
    expect(parsed.base).toBe("https://myapp.com/doc");
    expect(parsed.ipnsName).toBe("abc123");
    expect(arraysEqual(
      await exportKey(parsed.keys.readKey!),
      await exportKey(keys.readKey!)
    )).toBe(true);
  });

  it("handles trailing slash", async () => {
    const keys = await makeFullKeys();
    const url = await buildUrl(
      "https://myapp.com/doc/", "abc123", keys
    );
    expect(url).toContain("/doc/abc123#");
    const parsed = await parseUrl(url);
    expect(parsed.base).toBe("https://myapp.com/doc");
    expect(parsed.ipnsName).toBe("abc123");
  });

  it("throws on URL without fragment", async () => {
    await expect(
      parseUrl("https://myapp.com/doc/abc123")
    ).rejects.toThrow(/fragment/i);
  });
});

describe("narrowCapability", () => {
  it("narrows to subset of namespaces", async () => {
    const keys = await makeFullKeys();
    const narrowed = narrowCapability(keys, {
      namespaces: ["comments"],
    });
    expect(narrowed.readKey).toBeDefined();
    expect(narrowed.awarenessRoomPassword)
      .toBeDefined();
    expect(narrowed.ipnsKeyBytes).toBeUndefined();
    expect(narrowed.rotationKey).toBeUndefined();
    expect(Object.keys(narrowed.namespaceKeys!))
      .toEqual(["comments"]);
  });

  it("includes ipnsKeyBytes when canPushSnapshots",
    async () => {
      const keys = await makeFullKeys();
      const narrowed = narrowCapability(keys, {
        namespaces: ["content"],
        canPushSnapshots: true,
      });
      expect(narrowed.ipnsKeyBytes).toBeDefined();
      expect(narrowed.rotationKey).toBeUndefined();
    }
  );

  it("never includes rotationKey", async () => {
    const keys = await makeFullKeys();
    const narrowed = narrowCapability(keys, {
      namespaces: ["content", "comments"],
      canPushSnapshots: true,
    });
    expect(narrowed.rotationKey).toBeUndefined();
  });

  it("omits namespaceKeys if none granted",
    async () => {
      const keys = await makeFullKeys();
      const narrowed = narrowCapability(keys, {});
      expect(narrowed.namespaceKeys).toBeUndefined();
      expect(narrowed.readKey).toBeDefined();
    }
  );

  it("ignores namespaces not in source",
    async () => {
      const keys = await makeFullKeys();
      const narrowed = narrowCapability(keys, {
        namespaces: ["nonexistent"],
      });
      expect(narrowed.namespaceKeys).toBeUndefined();
    }
  );

  it("full narrow round-trip encode/decode",
    async () => {
      const keys = await makeFullKeys();
      const narrowed = narrowCapability(keys, {
        namespaces: ["comments"],
        canPushSnapshots: true,
      });
      const fragment = await encodeFragment(narrowed);
      const decoded = await decodeFragment(fragment);
      const cap = inferCapability(
        decoded, ["content", "comments"]
      );
      expect(cap.namespaces).toEqual(
        new Set(["comments"])
      );
      expect(cap.canPushSnapshots).toBe(true);
      expect(cap.isAdmin).toBe(false);
    }
  );
});

// --- Helpers ---

function base64urlDecode(s: string): Uint8Array {
  const padded =
    s + "=".repeat((4 - (s.length % 4)) % 4);
  const base64 = padded
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const bin = atob(base64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function base64urlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes, (b) =>
    String.fromCharCode(b)
  ).join("");
  return btoa(binStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
