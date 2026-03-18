import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import type { PrivateKey } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { FsBlockstore } from "blockstore-fs";
import { createLogger } from "@pokapali/log";

const log = createLogger("relay");

export const MAX_CONNECTIONS = 512;

export const DISCOVERY_TOPIC = "pokapali._peer-discovery._p2p._pubsub";
export const SIGNALING_TOPIC = "/pokapali/signaling";

const RAW_CODEC = 0x55;

export const PROVIDE_INTERVAL_MS = 5 * 60_000;
export const LOG_INTERVAL_MS = 30_000;
export const CAPS_INTERVAL_MS = 30_000;
export const HEALTH_CHECK_MIN_MS = 60_000;
export const HEALTH_CHECK_MAX_MS = 90_000;

export const DEFAULT_WS_PORT = 4003;
const KEY_FILENAME = "relay-key.bin";

export const RELAY_PEER_TAG = "pokapali-relay-peer";
export const RELAY_PEER_TAG_VALUE = 100;

export const BOOTSTRAP_ADDRS = [
  "/dnsaddr/bootstrap.libp2p.io/p2p/" +
    "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/" +
    "QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/dnsaddr/bootstrap.libp2p.io/p2p/" +
    "QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
];

export async function appIdToCID(appId: string): Promise<CID> {
  const bytes = new TextEncoder().encode("pokapali-relay:" + appId);
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

export async function networkCID(): Promise<CID> {
  const bytes = new TextEncoder().encode("pokapali-network");
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

/**
 * Derive an HTTPS URL from a WSS multiaddr.
 * e.g. /dns4/1-2-3-4.xxx.libp2p.direct/tcp/4003/tls/ws
 * → https://1-2-3-4.xxx.libp2p.direct:4443
 */
export function deriveHttpUrl(
  wssMultiaddr: string,
  httpsPort: number,
): string | undefined {
  const sni = wssMultiaddr.match(/\/sni\/([^/]+)\//);
  if (sni) return `https://${sni[1]}:${httpsPort}`;
  const dns = wssMultiaddr.match(/\/(dns[46])\/([^/]+)\/tcp/);
  if (dns) return `https://${dns[2]}:${httpsPort}`;
  return undefined;
}

/**
 * Derive httpUrl from the TLS cert SAN and relay's
 * public IP. Used when SNI multiaddr isn't registered
 * yet at cert provision time.
 */
export function deriveHttpUrlFromCert(
  certPem: string,
  multiaddrs: string[],
  httpsPort: number,
): string | undefined {
  let domain: string | undefined;
  try {
    const lines = certPem.split("\n").filter((l) => !l.startsWith("-----"));
    const der = Buffer.from(lines.join(""), "base64");
    const text = der.toString("latin1");
    const m = text.match(/\*\.([a-z0-9]+\.libp2p\.direct)/);
    if (m) domain = m[1];
  } catch {
    const m = certPem.match(/\*\.([a-z0-9]+\.libp2p\.direct)/);
    if (m) domain = m[1];
  }
  if (!domain) return undefined;

  const ipMatch = multiaddrs
    .filter((a) => !a.includes("/p2p-circuit/"))
    .map((a) => a.match(/^\/ip4\/((?:\d+\.){3}\d+)\//))
    .find((m) => m && !m[1]!.startsWith("127."));
  if (!ipMatch) return undefined;

  const ip = ipMatch[1]!;
  const dashed = ip.replace(/\./g, "-");
  return `https://${dashed}.${domain}:${httpsPort}`;
}

export async function loadOrCreateKey(
  storagePath: string,
): Promise<PrivateKey> {
  const keyPath = join(storagePath, KEY_FILENAME);
  try {
    const buf = await readFile(keyPath);
    const key = privateKeyFromProtobuf(buf);
    log.info("loaded existing key from", keyPath);
    return key;
  } catch {
    const key = await generateKeyPair("Ed25519");
    await mkdir(storagePath, { recursive: true });
    await writeFile(keyPath, privateKeyToProtobuf(key));
    log.info("generated new key, saved to", keyPath);
    return key;
  }
}

/**
 * Wrap FsBlockstore to fix blockstore-fs@3 get()
 * returning AsyncGenerator instead of Uint8Array.
 */
export async function openBlockstore(storagePath: string): Promise<{
  blockstore: Record<string, unknown>;
  close: () => Promise<void>;
}> {
  const rawBlockstore = new FsBlockstore(join(storagePath, "blockstore"));
  await rawBlockstore.open();

  const blockstore = {
    ...rawBlockstore,
    open: () => rawBlockstore.open(),
    close: () => rawBlockstore.close(),
    put: (k: CID, v: Uint8Array) => rawBlockstore.put(k, v),
    has: (k: CID) => rawBlockstore.has(k),
    delete: (k: CID) => rawBlockstore.delete(k),
    async get(key: CID): Promise<Uint8Array> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of rawBlockstore.get(key)) {
        chunks.push(chunk);
      }
      if (chunks.length === 1) return chunks[0]!;
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      return merged;
    },
  };

  return {
    blockstore: blockstore as Record<string, unknown>,
    close: () => rawBlockstore.close(),
  };
}
