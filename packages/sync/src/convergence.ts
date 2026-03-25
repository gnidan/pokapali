/**
 * Convergence -- per-channel convergence via
 * SV hash comparison over awareness.
 *
 * Timer -> per-channel state vector -> sha256.slice(0,8)
 * -> awareness.setLocalStateField -> compare peer hashes
 * -> all match for hysteresisCount consecutive checks
 * -> closeEpoch + reset.
 *
 * Requires >=2 peers. Timer-based, not event-driven.
 */
import * as Y from "yjs";
import { sha256 } from "@noble/hashes/sha256";
import type { SubdocManager } from "@pokapali/subdocs";
import type { Document } from "@pokapali/document";

/**
 * Awareness-compatible interface (subset of y-protocols
 * Awareness). Avoids importing the full y-protocols
 * type.
 */
interface AwarenessLike {
  clientID: number;
  setLocalStateField(field: string, value: unknown): void;
  getStates(): Map<number, Record<string, unknown>>;
}

export interface Convergence {
  destroy(): void;
}

/**
 * Create a Convergence instance.
 */
export const Convergence: {
  create(opts: {
    awareness: AwarenessLike;
    document: Document;
    subdocManager: SubdocManager;
    channelNames: string[];
    hysteresisCount?: number;
    checkIntervalMs?: number;
  }): Convergence;
} = {
  create(opts) {
    const {
      awareness,
      document,
      subdocManager,
      channelNames,
      hysteresisCount = 3,
      checkIntervalMs = 2000,
    } = opts;

    const counts = new Map<string, number>();
    for (const name of channelNames) {
      counts.set(name, 0);
    }

    function hashField(channelName: string): string {
      return `svHash:${channelName}`;
    }

    function computeHash(channelName: string): string {
      const doc = subdocManager.subdoc(channelName);
      const sv = Y.encodeStateVector(doc);
      const hash = sha256(sv).slice(0, 8);
      return Array.from(hash)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    function check(): void {
      for (const name of channelNames) {
        const hash = computeHash(name);
        awareness.setLocalStateField(hashField(name), hash);
      }

      const states = awareness.getStates();

      if (states.size < 2) return;

      for (const name of channelNames) {
        const field = hashField(name);
        const localHash = awareness.getStates().get(awareness.clientID)?.[
          field
        ] as string | undefined;

        if (!localHash) continue;

        let allMatch = true;
        for (const [, state] of states) {
          const peerHash = state[field] as string | undefined;
          if (peerHash !== localHash) {
            allMatch = false;
            break;
          }
        }

        if (!allMatch) {
          counts.set(name, 0);
          continue;
        }

        const count = (counts.get(name) ?? 0) + 1;
        counts.set(name, count);

        if (count >= hysteresisCount) {
          document.channel(name).closeEpoch();
          counts.set(name, 0);
        }
      }
    }

    const timer = setInterval(check, checkIntervalMs);

    return {
      destroy() {
        clearInterval(timer);
      },
    };
  },
};
