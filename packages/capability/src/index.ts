import type { DocKeys } from "@pokapali/crypto";

export interface CapabilityKeys {
  readKey?: CryptoKey;
  ipnsKeyBytes?: Uint8Array;
  rotationKey?: Uint8Array;
  awarenessRoomPassword?: string;
  namespaceKeys?: Record<string, Uint8Array>;
}

export interface Capability {
  namespaces: Set<string>;
  canPushSnapshots: boolean;
  isAdmin: boolean;
}

// Wire format:
//   version(1) || entry* sorted by label
//   entry = labelLen(1) || label(utf8) || valueLen(1)
//           || value
//
// Reserved labels:
//   "a" = awarenessRoomPassword (utf8 bytes)
//   "i" = ipnsKeyBytes
//   "k" = rotationKey
//   "n:<name>" = namespace key for <name>
//   "r" = readKey (raw AES-GCM-256 bytes)

const VERSION = 0x00;

export async function encodeFragment(
  keys: CapabilityKeys
): Promise<string> {
  const entries: Array<[string, Uint8Array]> = [];

  if (keys.readKey) {
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.readKey)
    );
    entries.push(["r", raw]);
  }
  if (keys.ipnsKeyBytes) {
    entries.push(["i", keys.ipnsKeyBytes]);
  }
  if (keys.rotationKey) {
    entries.push(["k", keys.rotationKey]);
  }
  if (keys.awarenessRoomPassword) {
    entries.push([
      "a",
      new TextEncoder().encode(
        keys.awarenessRoomPassword
      ),
    ]);
  }
  if (keys.namespaceKeys) {
    for (const [name, key] of Object.entries(
      keys.namespaceKeys
    )) {
      entries.push([`n:${name}`, key]);
    }
  }

  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  let totalLen = 1; // version byte
  for (const [label, value] of entries) {
    const labelBytes = new TextEncoder().encode(label);
    totalLen +=
      1 + labelBytes.length + 1 + value.length;
  }

  const buf = new Uint8Array(totalLen);
  let offset = 0;
  buf[offset++] = VERSION;

  for (const [label, value] of entries) {
    const labelBytes = new TextEncoder().encode(label);
    buf[offset++] = labelBytes.length;
    buf.set(labelBytes, offset);
    offset += labelBytes.length;
    buf[offset++] = value.length & 0xff;
    buf.set(value, offset);
    offset += value.length;
  }

  return base64urlEncode(buf);
}

export async function decodeFragment(
  fragment: string
): Promise<CapabilityKeys> {
  const buf = base64urlDecode(fragment);
  if (buf.length < 1) {
    throw new Error("Fragment too short");
  }
  const version = buf[0];
  if (version !== VERSION) {
    throw new Error(
      `Unknown fragment version: ${version}`
    );
  }

  const keys: CapabilityKeys = {};
  const namespaceKeys: Record<string, Uint8Array> = {};
  let offset = 1;

  while (offset < buf.length) {
    if (offset + 1 > buf.length) {
      throw new Error(
        "Truncated fragment: missing label length"
      );
    }
    const labelLen = buf[offset++];
    if (offset + labelLen > buf.length) {
      throw new Error(
        "Truncated fragment: missing label"
      );
    }
    const label = new TextDecoder().decode(
      buf.slice(offset, offset + labelLen)
    );
    offset += labelLen;

    if (offset + 1 > buf.length) {
      throw new Error(
        "Truncated fragment: missing value length"
      );
    }
    const valueLen = buf[offset++];
    if (offset + valueLen > buf.length) {
      throw new Error(
        "Truncated fragment: missing value"
      );
    }
    const value = buf.slice(offset, offset + valueLen);
    offset += valueLen;

    if (label === "r") {
      keys.readKey = await crypto.subtle.importKey(
        "raw",
        value as unknown as ArrayBuffer,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );
    } else if (label === "i") {
      keys.ipnsKeyBytes = value;
    } else if (label === "k") {
      keys.rotationKey = value;
    } else if (label === "a") {
      keys.awarenessRoomPassword =
        new TextDecoder().decode(value);
    } else if (label.startsWith("n:")) {
      namespaceKeys[label.slice(2)] = value;
    }
    // ignore unknown labels for forward compat
  }

  if (Object.keys(namespaceKeys).length > 0) {
    keys.namespaceKeys = namespaceKeys;
  }

  return keys;
}

export function inferCapability(
  keys: CapabilityKeys,
  namespaces: string[]
): Capability {
  const writable = new Set<string>();
  if (keys.namespaceKeys) {
    for (const ns of namespaces) {
      if (ns in keys.namespaceKeys) {
        writable.add(ns);
      }
    }
  }

  return {
    namespaces: writable,
    canPushSnapshots: !!keys.ipnsKeyBytes,
    isAdmin: !!keys.rotationKey,
  };
}

export interface ParsedUrl {
  base: string;
  ipnsName: string;
  keys: CapabilityKeys;
}

export async function buildUrl(
  base: string,
  ipnsName: string,
  keys: CapabilityKeys
): Promise<string> {
  const fragment = await encodeFragment(keys);
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}${ipnsName}#${fragment}`;
}

export async function parseUrl(
  url: string
): Promise<ParsedUrl> {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) {
    throw new Error("URL has no fragment");
  }
  const fragment = url.slice(hashIdx + 1);
  const pathPart = url.slice(0, hashIdx);

  const lastSlash = pathPart.lastIndexOf("/");
  if (lastSlash === -1) {
    throw new Error("URL has no path separator");
  }
  const base = pathPart.slice(0, lastSlash);
  const ipnsName = pathPart.slice(lastSlash + 1);

  const keys = await decodeFragment(fragment);
  return { base, ipnsName, keys };
}

export interface CapabilityGrant {
  namespaces?: string[];
  canPushSnapshots?: boolean;
}

export function narrowCapability(
  keys: CapabilityKeys,
  grant: CapabilityGrant
): CapabilityKeys {
  const result: CapabilityKeys = {};

  // readKey and awarenessRoomPassword always included
  if (keys.readKey) {
    result.readKey = keys.readKey;
  }
  if (keys.awarenessRoomPassword) {
    result.awarenessRoomPassword =
      keys.awarenessRoomPassword;
  }

  // ipnsKeyBytes only if grant allows pushing
  if (grant.canPushSnapshots && keys.ipnsKeyBytes) {
    result.ipnsKeyBytes = keys.ipnsKeyBytes;
  }

  // rotationKey never narrowed (admin only)

  // namespace keys: only those in the grant
  if (grant.namespaces && keys.namespaceKeys) {
    const narrowed: Record<string, Uint8Array> = {};
    for (const ns of grant.namespaces) {
      if (ns in keys.namespaceKeys) {
        narrowed[ns] = keys.namespaceKeys[ns];
      }
    }
    if (Object.keys(narrowed).length > 0) {
      result.namespaceKeys = narrowed;
    }
  }

  return result;
}

// Re-export DocKeys for convenience
export type { DocKeys };

// --- Encoding utilities ---

function base64urlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes, (b) =>
    String.fromCharCode(b)
  ).join("");
  return btoa(binStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const padded =
    s + "=".repeat((4 - (s.length % 4)) % 4);
  const base64 = padded
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const bin = atob(base64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
