import { ipns } from "@helia/ipns";
import {
  generateKeyPairFromSeed,
  publicKeyFromRaw,
} from "@libp2p/crypto/keys";
import type { Helia } from "helia";
import {
  CID as CIDClass,
  type CID,
} from "multiformats/cid";

const LIBP2P_KEY_CODEC = 0x72;
const PUBLISH_TIMEOUT_MS = 30_000;

/**
 * Publish an IPNS record mapping ipnsKeyBytes → cid.
 *
 * Creates the record offline, then publishes in two
 * parallel paths:
 *
 * 1. Direct delegated HTTP publish (fast, reliable) —
 *    we await this and resolve once it succeeds.
 *
 * 2. Full Helia routing publish (DHT + delegated) —
 *    fire-and-forget in the background. May hang in
 *    browser due to sparse DHT, but if it works the
 *    record propagates more broadly.
 *
 * NOTE: Accessing helia.libp2p.services.delegatedRouting
 * directly is a code smell (couples us to Helia's
 * default service name). If Helia changes how it
 * registers the delegated router, this will silently
 * fall back to the full routing path only. Tracked as
 * tech debt.
 */
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

  // Create and locally cache the record without
  // publishing to any routers.
  const record = await name.publish(
    privateKey, cid, { offline: true },
  );

  // Path 1: Direct delegated HTTP publish (fast).
  const delegated = (helia.libp2p.services as any)
    .delegatedRouting;
  if (delegated?.putIPNS) {
    const keyCid = CIDClass.createV1(
      LIBP2P_KEY_CODEC,
      privateKey.publicKey.toMultihash(),
    );
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      PUBLISH_TIMEOUT_MS,
    );
    try {
      await delegated.putIPNS(
        keyCid, record, { signal: ctrl.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Path 2: Full Helia routing (DHT + delegated).
  // Fire-and-forget — may hang in browser, but if
  // it works, the record propagates more broadly.
  name.publish(privateKey, cid).catch(() => {});
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
