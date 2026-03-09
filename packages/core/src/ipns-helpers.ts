import { createIPNSRecord } from "ipns";
import type { IPNSRecord } from "ipns";
import {
  generateKeyPairFromSeed,
  publicKeyFromRaw,
} from "@libp2p/crypto/keys";
import { ipns } from "@helia/ipns";
import type { Helia } from "helia";
import {
  CID as CIDClass,
  type CID,
} from "multiformats/cid";
import { createLogger } from "@pokapali/log";

const log = createLogger("ipns");

const LIBP2P_KEY_CODEC = 0x72;
const PUBLISH_TIMEOUT_MS = 30_000;
const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Per-key publish queue. Serializes IPNS publishes
 * within one browser tab so concurrent pushSnapshot
 * calls don't overlap. If a publish is in flight and a
 * newer CID is queued, the stale CID is skipped.
 */
const publishQueues = new Map<string, {
  inflight: Promise<void>;
  pending: { cid: CID; seq: bigint } | null;
}>();

async function enqueuePublish(
  keyHex: string,
  cid: CID,
  seq: bigint,
  doPublish: (cid: CID, seq: bigint) => Promise<void>,
): Promise<void> {
  const entry = publishQueues.get(keyHex);

  if (entry) {
    // A publish is already in flight. Replace any
    // pending CID with the newest one — stale CIDs
    // are pointless to publish.
    log.debug("publish queued (in-flight)");
    entry.pending = { cid, seq };
    return;
  }

  const run = async (
    currentCid: CID,
    currentSeq: bigint,
  ) => {
    try {
      await doPublish(currentCid, currentSeq);
    } catch (err) {
      log.error("publish failed:", err);
    }

    const q = publishQueues.get(keyHex);
    if (q?.pending) {
      const next = q.pending;
      q.pending = null;
      q.inflight = run(next.cid, next.seq);
      await q.inflight;
    } else {
      publishQueues.delete(keyHex);
    }
  };

  const inflight = run(cid, seq);
  publishQueues.set(keyHex, {
    inflight,
    pending: null,
  });
  await inflight;
}

/**
 * Publish an IPNS record mapping ipnsKeyBytes → cid.
 *
 * Uses the caller-provided `clockSum` (derived from the
 * Y.Doc state vector) as the IPNS sequence number. This
 * makes the seq deterministic: same doc state → same
 * seq, so multiple browsers publishing the same snapshot
 * produce identical records (no race). A browser with
 * more edits naturally gets a higher seq.
 *
 * Serialized per key within a tab via publish queue.
 *
 * Publishes directly via delegated HTTP, bypassing
 * Helia's composed routing (DHT hangs in browsers).
 */
export async function publishIPNS(
  helia: Helia,
  ipnsKeyBytes: Uint8Array,
  cid: CID,
  clockSum: number,
): Promise<void> {
  const keyHex = Array.from(
    ipnsKeyBytes,
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

  await enqueuePublish(
    keyHex,
    cid,
    BigInt(clockSum),
    async (cidToPublish, seq) => {
      log.debug(
        "doPublish: seq=" + seq + " cid=" +
          cidToPublish.toString().slice(0, 16) +
          "...",
      );
      const privateKey = await generateKeyPairFromSeed(
        "Ed25519",
        ipnsKeyBytes,
      );

      const delegated = (helia.libp2p.services as any)
        .delegatedRouting;
      if (!delegated?.putIPNS) {
        log.warn(
          "no delegatedRouting.putIPNS"
            + " — skipping",
        );
        return;
      }

      const keyCid = CIDClass.createV1(
        LIBP2P_KEY_CODEC,
        privateKey.publicKey.toMultihash(),
      );

      // Ensure seq exceeds any existing record so the
      // delegated server accepts the update. Handles
      // cases where clock sum is temporarily lower
      // (e.g. page reload before full sync).
      let effectiveSeq = seq;
      if (delegated.getIPNS) {
        try {
          const existing: IPNSRecord =
            await delegated.getIPNS(keyCid, {
              signal: AbortSignal.timeout(5_000),
            });
          const existingSeq =
            existing.sequence ?? 0n;
          log.debug(
            "existing seq=" + existingSeq +
              " clockSum seq=" + seq,
          );
          if (existingSeq >= effectiveSeq) {
            effectiveSeq = existingSeq + 1n;
          }
        } catch {
          log.debug("no existing record");
        }
      }

      log.debug(
        "publishing with effectiveSeq=" +
          effectiveSeq,
      );

      const record =
        await (createIPNSRecord as Function)(
          privateKey,
          cidToPublish,
          effectiveSeq,
          DEFAULT_LIFETIME_MS,
        ) as IPNSRecord;

      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        PUBLISH_TIMEOUT_MS,
      );
      try {
        await delegated.putIPNS(
          keyCid,
          record,
          { signal: ctrl.signal },
        );
        log.info(
          "putIPNS success seq=" + effectiveSeq,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );
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

  // Try delegated HTTP first (fast, reliable).
  const delegated = (helia.libp2p.services as any)
    .delegatedRouting;
  if (delegated?.getIPNS) {
    const keyCid = CIDClass.createV1(
      LIBP2P_KEY_CODEC,
      publicKey.toMultihash(),
    );
    try {
      const record: IPNSRecord =
        await delegated.getIPNS(keyCid, {
          signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        });
      // value is "/ipfs/<cid>" string
      const val = record.value;
      const cidStr = val.startsWith("/ipfs/")
        ? val.slice(6)
        : val;
      log.debug(
        "resolve (delegated):",
        cidStr.slice(0, 16) + "...",
      );
      return CIDClass.parse(cidStr);
    } catch (err) {
      log.debug(
        "delegated resolve failed,"
          + " falling back to DHT:",
        err,
      );
    }
  } else {
    log.warn(
      "resolve: no delegated routing available",
    );
  }

  // Fallback: full Helia routing (includes DHT).
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
    log.debug(
      "resolve (DHT):",
      result.cid.toString().slice(0, 16) + "...",
    );
    return result.cid;
  } catch (err) {
    log.warn(
      "resolve failed (both paths):", err,
    );
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
