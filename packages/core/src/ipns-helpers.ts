import { ipns } from "@helia/ipns";
import {
  generateKeyPairFromSeed,
  publicKeyFromRaw,
} from "@libp2p/crypto/keys";
import type { Helia } from "helia";
import type { CID } from "multiformats/cid";

/**
 * Publish an IPNS record mapping ipnsKeyBytes → cid.
 *
 * @param helia        running Helia instance
 * @param ipnsKeyBytes 32-byte Ed25519 seed
 * @param cid          CID to publish
 */
const PUBLISH_TIMEOUT_MS = 30_000;

export async function publishIPNS(
  helia: Helia,
  ipnsKeyBytes: Uint8Array,
  cid: CID,
): Promise<void> {
  const privateKey = await generateKeyPairFromSeed(
    "Ed25519",
    ipnsKeyBytes,
  );
  const name = ipns(helia);
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    PUBLISH_TIMEOUT_MS,
  );
  try {
    await name.publish(privateKey, cid, {
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an IPNS name to a CID.
 *
 * @param helia          running Helia instance
 * @param publicKeyBytes raw 32-byte Ed25519 public key
 * @returns resolved CID or null if resolution fails
 */
const RESOLVE_TIMEOUT_MS = 15_000;

export async function resolveIPNS(
  helia: Helia,
  publicKeyBytes: Uint8Array,
): Promise<CID | null> {
  const publicKey = publicKeyFromRaw(publicKeyBytes);
  const name = ipns(helia);
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    RESOLVE_TIMEOUT_MS,
  );
  try {
    const result = await name.resolve(publicKey, {
      signal: ctrl.signal,
    });
    return result.cid;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll resolveIPNS at an interval; call onUpdate when
 * the resolved CID changes.
 *
 * @returns a stop function to cancel polling
 */
export function watchIPNS(
  helia: Helia,
  publicKeyBytes: Uint8Array,
  onUpdate: (cid: CID) => void,
  intervalMs = 30_000,
): () => void {
  let lastCid: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function poll() {
    if (stopped) return;
    try {
      const cid = await resolveIPNS(
        helia,
        publicKeyBytes,
      );
      if (cid) {
        const cidStr = cid.toString();
        if (cidStr !== lastCid) {
          lastCid = cidStr;
          onUpdate(cid);
        }
      }
    } catch {
      // Ignore poll errors
    }
    if (!stopped) {
      timer = setTimeout(poll, intervalMs);
    }
  }

  poll();

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
  };
}
