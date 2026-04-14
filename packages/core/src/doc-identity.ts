/**
 * doc-identity.ts — Client identity mapping and
 * participant awareness helpers.
 *
 * Extracted from create-doc.ts for composability.
 * No ambient closure state — all dependencies are
 * passed explicitly.
 */

import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { hexToBytes, bytesToHex, verifyBytes } from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { SNAPSHOT_ORIGIN } from "@pokapali/sync";
import { signParticipant } from "./identity.js";
import type { ParticipantAwareness } from "./identity.js";
import { createFeed } from "./feed.js";
import type { WritableFeed } from "./feed.js";
import type { ClientIdentityInfo } from "./create-doc.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("core");

// ── Client identity mapping ─────────────────────

export type IdentityMap = ReadonlyMap<number, ClientIdentityInfo>;

const EMPTY_IDENTITY_MAP: IdentityMap = new Map();

export interface ClientIdMappingHandle {
  feed: WritableFeed<IdentityMap>;
  /** Call to stop observing the Y.Map. */
  destroy: () => void;
}

/**
 * Creates a reactive Feed that projects _meta
 * "clientIdentities" Y.Map into a verified
 * identity map. Signatures are verified lazily
 * and cached.
 */
export function createClientIdMapping(
  metaDoc: Y.Doc,
  ipnsName: string,
): ClientIdMappingHandle {
  const feed: WritableFeed<IdentityMap> =
    createFeed<IdentityMap>(EMPTY_IDENTITY_MAP);

  // Cache verified results to avoid re-verifying
  // on every Y.Map change.
  const verifiedCache = new Map<string, boolean | null>();

  function rebuild(): void {
    const identities = metaDoc.getMap("clientIdentities");
    const result = new Map<number, ClientIdentityInfo>();

    for (const [key, value] of identities.entries()) {
      const clientId = Number(key);
      if (Number.isNaN(clientId)) continue;
      const entry = value as {
        pubkey?: string;
        sig?: string;
        v?: number;
      };
      if (!entry?.pubkey || !entry?.sig) continue;

      const cached = verifiedCache.get(key);
      if (cached !== undefined && cached !== null) {
        result.set(clientId, {
          pubkey: entry.pubkey,
          verified: cached,
        });
      } else {
        // Optimistic: show as unverified until
        // async verification completes.
        result.set(clientId, {
          pubkey: entry.pubkey,
          verified: false,
        });
        if (cached === undefined) {
          // null = in-flight
          verifiedCache.set(key, null);
          // v2 payload includes clientID binding;
          // v1 (no version field) uses legacy format.
          const raw =
            entry.v === 2
              ? entry.pubkey + ":" + key + ":" + ipnsName
              : entry.pubkey + ":" + ipnsName;
          const payload = new TextEncoder().encode(raw);
          verifyBytes(hexToBytes(entry.pubkey), hexToBytes(entry.sig), payload)
            .then((ok) => {
              verifiedCache.set(key, ok);
              rebuild();
            })
            .catch(() => {
              verifiedCache.set(key, false);
              rebuild();
            });
        }
      }
    }

    feed._update(result);
  }

  // Observe _meta clientIdentities for changes.
  const identitiesMap = metaDoc.getMap("clientIdentities");
  identitiesMap.observe(rebuild);

  // Initial projection (may already have entries
  // from IDB-persisted _meta).
  rebuild();

  return {
    feed,
    destroy: () => identitiesMap.unobserve(rebuild),
  };
}

// ── Participant awareness ───────────────────────

/**
 * Publish identity into awareness and persist
 * clientID→pubkey in _meta. Also syncs
 * displayName from awareness "user" field.
 *
 * Returns a cleanup function to stop observing
 * awareness changes.
 */
export function setupParticipantAwareness(
  identity: Ed25519KeyPair | undefined | null,
  awareness: Awareness,
  metaDoc: Y.Doc,
  ipnsName: string,
): () => void {
  if (identity) {
    const kp = identity;
    const clientId = awareness.clientID;
    signParticipant(kp, ipnsName, clientId)
      .then(({ sig, v }) => {
        const userState = awareness.getLocalState() as Record<
          string,
          unknown
        > | null;
        const userName = (userState?.user as { name?: string } | undefined)
          ?.name;

        const participant: ParticipantAwareness = {
          pubkey: bytesToHex(kp.publicKey),
          sig,
          ...(v ? { v } : {}),
          ...(userName ? { displayName: userName } : {}),
        };
        awareness.setLocalStateField("participant", participant);

        // Persist clientID→pubkey in _meta so the
        // mapping survives across snapshots.
        // Use SNAPSHOT_ORIGIN so the write doesn't
        // mark the doc dirty — this is infrastructure
        // metadata, not a user edit (#357).
        metaDoc.transact(() => {
          const identities = metaDoc.getMap("clientIdentities");
          identities.set(String(clientId), {
            pubkey: bytesToHex(kp.publicKey),
            sig,
            v: 2,
          });
        }, SNAPSHOT_ORIGIN);
      })
      .catch((err) => {
        log.warn(
          "participant awareness failed:",
          (err as Error)?.message ?? err,
        );
      });
  }

  // Auto-sync awareness "user".name →
  // "participant".displayName (#191).
  function syncDisplayName() {
    const local = awareness.getLocalState() as Record<string, unknown> | null;
    if (!local) return;
    const participant = local.participant as ParticipantAwareness | undefined;
    if (!participant?.pubkey) return;

    const userName = (local.user as { name?: string } | undefined)?.name;
    if ((participant.displayName ?? "") === (userName ?? "")) {
      return;
    }
    awareness.setLocalStateField("participant", {
      ...participant,
      displayName: userName,
    });
  }

  awareness.on("change", syncDisplayName);

  return () => {
    awareness.off("change", syncDisplayName);
  };
}
