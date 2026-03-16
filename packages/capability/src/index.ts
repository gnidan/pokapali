import type { DocKeys } from "@pokapali/crypto";
import { base64urlEncode } from "@pokapali/crypto";

export interface CapabilityKeys {
  readKey?: CryptoKey;
  ipnsKeyBytes?: Uint8Array;
  rotationKey?: Uint8Array;
  awarenessRoomPassword?: string;
  channelKeys?: Record<string, Uint8Array>;
}

export interface Capability {
  channels: Set<string>;
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

export async function encodeFragment(keys: CapabilityKeys): Promise<string> {
  const entries: Array<[string, Uint8Array]> = [];

  if (keys.readKey) {
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.readKey),
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
    entries.push(["a", new TextEncoder().encode(keys.awarenessRoomPassword)]);
  }
  // Wire format uses "n:" prefix for channel keys
  // (historical — kept for backward compatibility).
  const chKeys = keys.channelKeys;
  if (chKeys) {
    for (const [name, key] of Object.entries(chKeys)) {
      entries.push([`n:${name}`, key]);
    }
  }

  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  let totalLen = 1; // version byte
  for (const [label, value] of entries) {
    const labelBytes = new TextEncoder().encode(label);
    totalLen += 1 + labelBytes.length + 1 + value.length;
  }

  const buf = new Uint8Array(totalLen);
  let offset = 0;
  buf[offset++] = VERSION;

  for (const [label, value] of entries) {
    const labelBytes = new TextEncoder().encode(label);
    if (labelBytes.length > 255) {
      throw new Error(
        `Label too long: "${label}" ` + `(${labelBytes.length} bytes)`,
      );
    }
    if (value.length > 255) {
      throw new Error(
        `Value too long for label "${label}" ` + `(${value.length} bytes)`,
      );
    }
    buf[offset++] = labelBytes.length;
    buf.set(labelBytes, offset);
    offset += labelBytes.length;
    buf[offset++] = value.length;
    buf.set(value, offset);
    offset += value.length;
  }

  return base64urlEncode(buf);
}

export async function decodeFragment(
  fragment: string,
): Promise<CapabilityKeys> {
  const buf = base64urlDecode(fragment);
  if (buf.length < 1) {
    throw new Error(
      "Fragment too short — the URL fragment should" +
        " contain an encoded capability." +
        " Check that the URL was not truncated",
    );
  }
  const version = buf[0];
  if (version !== VERSION) {
    throw new Error(
      `Unknown fragment version: ${version}` +
        " — this URL may have been created by a" +
        " newer version of pokapali",
    );
  }

  const keys: CapabilityKeys = {};
  const channelKeys: Record<string, Uint8Array> = {};
  let offset = 1;

  while (offset < buf.length) {
    if (offset + 1 > buf.length) {
      throw new Error(
        "Truncated capability fragment at byte " +
          `${offset}: missing label length.` +
          " The URL may have been truncated" +
          " when copied",
      );
    }
    const labelLen = buf[offset++];
    if (offset + labelLen > buf.length) {
      throw new Error(
        "Truncated capability fragment at byte " +
          `${offset}: expected ${labelLen}-byte` +
          " label. The URL may have been" +
          " truncated when copied",
      );
    }
    const label = new TextDecoder().decode(
      buf.slice(offset, offset + labelLen),
    );
    offset += labelLen;

    if (offset + 1 > buf.length) {
      throw new Error(
        "Truncated capability fragment at byte " +
          `${offset}: missing value length.` +
          " The URL may have been truncated" +
          " when copied",
      );
    }
    const valueLen = buf[offset++];
    if (offset + valueLen > buf.length) {
      throw new Error(
        "Truncated capability fragment at byte " +
          `${offset}: expected ${valueLen}-byte` +
          " value. The URL may have been" +
          " truncated when copied",
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
        ["encrypt", "decrypt"],
      );
    } else if (label === "i") {
      keys.ipnsKeyBytes = value;
    } else if (label === "k") {
      keys.rotationKey = value;
    } else if (label === "a") {
      keys.awarenessRoomPassword = new TextDecoder().decode(value);
    } else if (label.startsWith("n:")) {
      // Wire format "n:" → channelKeys
      channelKeys[label.slice(2)] = value;
    }
    // ignore unknown labels for forward compat
  }

  if (Object.keys(channelKeys).length > 0) {
    keys.channelKeys = channelKeys;
  }

  return keys;
}

export function inferCapability(
  keys: CapabilityKeys,
  channels: string[],
): Capability {
  const writable = new Set<string>();
  if (keys.channelKeys) {
    for (const ch of channels) {
      if (ch in keys.channelKeys) {
        writable.add(ch);
      }
    }
  }

  return {
    channels: writable,
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
  keys: CapabilityKeys,
): Promise<string> {
  const fragment = await encodeFragment(keys);
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${b}/doc/${ipnsName}#${fragment}`;
}

export async function parseUrl(url: string): Promise<ParsedUrl> {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) {
    throw new Error(
      "URL has no fragment — a pokapali URL must" +
        " contain a '#' followed by the encoded" +
        " capability (e.g., https://example.com" +
        "/doc/<ipnsName>#<capability>)",
    );
  }
  const fragment = url.slice(hashIdx + 1);
  const pathPart = url.slice(0, hashIdx);

  const docIdx = pathPart.indexOf("/doc/");
  if (docIdx === -1) {
    throw new Error(
      "URL missing /doc/ path segment — a pokapali" +
        " URL must contain /doc/<ipnsName>" +
        " (e.g., https://example.com/doc/<ipnsName>" +
        "#<capability>)",
    );
  }
  const base = pathPart.slice(0, docIdx);
  const ipnsName = pathPart.slice(docIdx + 5);

  const keys = await decodeFragment(fragment);
  return { base, ipnsName, keys };
}

export interface CapabilityGrant {
  channels?: string[];
  canPushSnapshots?: boolean;
}

export function narrowCapability(
  keys: CapabilityKeys,
  grant: CapabilityGrant,
): CapabilityKeys {
  const result: CapabilityKeys = {};

  // readKey and awarenessRoomPassword always included
  if (keys.readKey) {
    result.readKey = keys.readKey;
  }
  if (keys.awarenessRoomPassword) {
    result.awarenessRoomPassword = keys.awarenessRoomPassword;
  }

  // ipnsKeyBytes only if grant allows pushing
  if (grant.canPushSnapshots && keys.ipnsKeyBytes) {
    result.ipnsKeyBytes = keys.ipnsKeyBytes;
  }

  // rotationKey never narrowed (admin only)

  // channel keys: only those in the grant
  if (grant.channels && keys.channelKeys) {
    const narrowed: Record<string, Uint8Array> = {};
    for (const ch of grant.channels) {
      if (ch in keys.channelKeys) {
        narrowed[ch] = keys.channelKeys[ch];
      }
    }
    if (Object.keys(narrowed).length > 0) {
      result.channelKeys = narrowed;
    }
  }

  return result;
}

// Re-export DocKeys for convenience
export type { DocKeys };

// --- Encoding utilities ---

function base64urlDecode(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(base64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
