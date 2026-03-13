/**
 * Identity persistence — generate or load a
 * per-device Ed25519 keypair from IndexedDB.
 *
 * One keypair per appId. The keypair identifies this
 * browser/device across all docs for the app.
 */

import type { Ed25519KeyPair } from "@pokapali/crypto";
import {
  ed25519KeyPairFromSeed,
  bytesToHex,
  signBytes,
} from "@pokapali/crypto";

const DB_NAME_PREFIX = "pokapali:identity:";
const STORE_NAME = "keypair";
const KEY_ID = "device";

function openDB(appId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME_PREFIX + appId, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new Error("Failed to open identity DB: " + req.error?.message));
  });
}

function idbGet(db: IDBDatabase): Promise<{ seed: Uint8Array } | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(KEY_ID);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, value: { seed: Uint8Array }): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, KEY_ID);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Load or generate the device identity keypair for
 * this appId. Persists the seed in IndexedDB so the
 * same identity is used across page reloads.
 */
export async function loadIdentity(appId: string): Promise<Ed25519KeyPair> {
  const db = await openDB(appId);
  try {
    const existing = await idbGet(db);
    if (existing?.seed) {
      return ed25519KeyPairFromSeed(existing.seed);
    }
    // Generate new seed
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    await idbPut(db, { seed });
    return ed25519KeyPairFromSeed(seed);
  } finally {
    db.close();
  }
}

/**
 * Sign a participant awareness payload: covers
 * (pubkey, docId) to prevent cross-doc replay.
 * Returns hex-encoded signature.
 */
export async function signParticipant(
  keypair: Ed25519KeyPair,
  docId: string,
): Promise<string> {
  const pubkeyHex = bytesToHex(keypair.publicKey);
  const payload = new TextEncoder().encode(pubkeyHex + ":" + docId);
  const sig = await signBytes(keypair, payload);
  return bytesToHex(sig);
}

export interface ParticipantAwareness {
  pubkey: string;
  displayName?: string;
  sig: string;
}
