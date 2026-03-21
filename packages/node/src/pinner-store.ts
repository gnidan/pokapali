/**
 * LevelDB-backed pinner state storage.
 *
 * Replaces state.json bulk serialization with
 * individual key-value operations. Each mutation
 * is persisted immediately — no dirty flags or
 * debounced writes needed.
 *
 * Key scheme:
 *   /kn/<ipnsName>     → "" (presence = known)
 *   /tip/<ipnsName>    → CID string
 *   /app/<ipnsName>    → appId string
 *   /seen/<ipnsName>   → timestamp ms (string)
 *   /res/<ipnsName>    → timestamp ms (string)
 *   /deact/<ipnsName>  → "" (presence = deactivated)
 */

import { LevelDatastore } from "datastore-level";
import { Key as RawKey } from "interface-datastore";
import { createLogger } from "@pokapali/log";

function Key(s: string): RawKey {
  return new RawKey(s);
}

const log = createLogger("pinner-store");

const PREFIX_KN = "/kn/";
const PREFIX_TIP = "/tip/";
const PREFIX_APP = "/app/";
const PREFIX_SEEN = "/seen/";
const PREFIX_RES = "/res/";
const PREFIX_DEACT = "/deact/";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(s: string): Uint8Array {
  return encoder.encode(s);
}

function decode(b: Uint8Array): string {
  return decoder.decode(b);
}

export interface PinnerStore {
  open(): Promise<void>;
  close(): Promise<void>;

  /** Add a known IPNS name. */
  addName(name: string): Promise<void>;
  /** Remove a known IPNS name and all associated
   * keys (tip, app, seen). */
  removeName(name: string): Promise<void>;
  /** Check if a name is known. */
  hasName(name: string): Promise<boolean>;
  /** All known IPNS names. */
  getNames(): Promise<Set<string>>;

  /** Set the tip CID for a name. */
  setTip(name: string, cid: string): Promise<void>;
  /** Get the tip CID for a name, or null. */
  getTip(name: string): Promise<string | null>;
  /** All tips as a Map. */
  getTips(): Promise<Map<string, string>>;

  /** Set the appId for a name. */
  setAppId(name: string, appId: string): Promise<void>;
  /** Get the appId for a name, or null. */
  getAppId(name: string): Promise<string | null>;
  /** All appId mappings as a Map. */
  getAppIds(): Promise<Map<string, string>>;

  /** Set last-seen timestamp for a name. */
  setLastSeen(name: string, ts: number): Promise<void>;
  /** Get last-seen timestamp, or null. */
  getLastSeen(name: string): Promise<number | null>;
  /** All last-seen timestamps as a Map. */
  getLastSeenAll(): Promise<Map<string, number>>;

  /** Set last-resolved timestamp for a name. */
  setLastResolved(name: string, ts: number): Promise<void>;
  /** Get last-resolved timestamp, or null. */
  getLastResolved(name: string): Promise<number | null>;
  /** All last-resolved timestamps as a Map. */
  getLastResolvedAll(): Promise<Map<string, number>>;

  /** Mark a name as deactivated (passive phase). */
  setDeactivated(name: string): Promise<void>;
  /** Clear deactivated status for a name. */
  clearDeactivated(name: string): Promise<void>;
  /** All deactivated names. */
  getDeactivatedNames(): Promise<Set<string>>;

  /** Batch-import state (for migration). */
  importState(state: {
    knownNames: string[];
    tips: Record<string, string>;
    nameToAppId?: Record<string, string>;
    lastSeenAt?: Record<string, number>;
  }): Promise<void>;
}

export async function createPinnerStore(path: string): Promise<PinnerStore> {
  const ds = new LevelDatastore(path);

  async function open(): Promise<void> {
    await ds.open();
  }

  async function close(): Promise<void> {
    await ds.close();
  }

  async function addName(name: string): Promise<void> {
    await ds.put(Key(PREFIX_KN + name), encode(""));
  }

  async function removeName(name: string): Promise<void> {
    const batch = ds.batch();
    batch.delete(Key(PREFIX_KN + name));
    batch.delete(Key(PREFIX_TIP + name));
    batch.delete(Key(PREFIX_APP + name));
    batch.delete(Key(PREFIX_SEEN + name));
    batch.delete(Key(PREFIX_RES + name));
    batch.delete(Key(PREFIX_DEACT + name));
    await batch.commit();
  }

  async function hasName(name: string): Promise<boolean> {
    return ds.has(Key(PREFIX_KN + name));
  }

  async function getNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for await (const { key } of ds.query({
      prefix: PREFIX_KN,
    })) {
      const name = key.toString().slice(PREFIX_KN.length);
      names.add(name);
    }
    return names;
  }

  async function setTip(name: string, cid: string): Promise<void> {
    await ds.put(Key(PREFIX_TIP + name), encode(cid));
  }

  async function getTip(name: string): Promise<string | null> {
    try {
      const val = await ds.get(Key(PREFIX_TIP + name));
      return decode(val);
    } catch {
      return null;
    }
  }

  async function getTips(): Promise<Map<string, string>> {
    const tips = new Map<string, string>();
    for await (const { key, value } of ds.query({
      prefix: PREFIX_TIP,
    })) {
      const name = key.toString().slice(PREFIX_TIP.length);
      tips.set(name, decode(value));
    }
    return tips;
  }

  async function setAppId(name: string, appId: string): Promise<void> {
    await ds.put(Key(PREFIX_APP + name), encode(appId));
  }

  async function getAppId(name: string): Promise<string | null> {
    try {
      const val = await ds.get(Key(PREFIX_APP + name));
      return decode(val);
    } catch {
      return null;
    }
  }

  async function getAppIds(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for await (const { key, value } of ds.query({
      prefix: PREFIX_APP,
    })) {
      const name = key.toString().slice(PREFIX_APP.length);
      map.set(name, decode(value));
    }
    return map;
  }

  async function setLastSeen(name: string, ts: number): Promise<void> {
    await ds.put(Key(PREFIX_SEEN + name), encode(String(ts)));
  }

  async function getLastSeen(name: string): Promise<number | null> {
    try {
      const val = await ds.get(Key(PREFIX_SEEN + name));
      const n = Number(decode(val));
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async function getLastSeenAll(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for await (const { key, value } of ds.query({
      prefix: PREFIX_SEEN,
    })) {
      const name = key.toString().slice(PREFIX_SEEN.length);
      const n = Number(decode(value));
      if (Number.isFinite(n)) map.set(name, n);
    }
    return map;
  }

  async function setLastResolved(name: string, ts: number): Promise<void> {
    await ds.put(Key(PREFIX_RES + name), encode(String(ts)));
  }

  async function getLastResolved(name: string): Promise<number | null> {
    try {
      const val = await ds.get(Key(PREFIX_RES + name));
      const n = Number(decode(val));
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async function getLastResolvedAll(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for await (const { key, value } of ds.query({
      prefix: PREFIX_RES,
    })) {
      const name = key.toString().slice(PREFIX_RES.length);
      const n = Number(decode(value));
      if (Number.isFinite(n)) map.set(name, n);
    }
    return map;
  }

  async function setDeactivated(name: string): Promise<void> {
    await ds.put(Key(PREFIX_DEACT + name), encode(""));
  }

  async function clearDeactivated(name: string): Promise<void> {
    try {
      await ds.delete(Key(PREFIX_DEACT + name));
    } catch {
      // Key missing — fine
    }
  }

  async function getDeactivatedNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for await (const { key } of ds.query({
      prefix: PREFIX_DEACT,
    })) {
      const name = key.toString().slice(PREFIX_DEACT.length);
      names.add(name);
    }
    return names;
  }

  async function importState(state: {
    knownNames: string[];
    tips: Record<string, string>;
    nameToAppId?: Record<string, string>;
    lastSeenAt?: Record<string, number>;
  }): Promise<void> {
    const batch = ds.batch();
    for (const name of state.knownNames) {
      batch.put(Key(PREFIX_KN + name), encode(""));
    }
    for (const [name, cid] of Object.entries(state.tips)) {
      batch.put(Key(PREFIX_TIP + name), encode(cid));
    }
    if (state.nameToAppId) {
      for (const [name, appId] of Object.entries(state.nameToAppId)) {
        batch.put(Key(PREFIX_APP + name), encode(appId));
      }
    }
    if (state.lastSeenAt) {
      for (const [name, ts] of Object.entries(state.lastSeenAt)) {
        batch.put(Key(PREFIX_SEEN + name), encode(String(ts)));
      }
    }
    await batch.commit();
    log.info(
      `imported ${state.knownNames.length} names` + ` into LevelDB store`,
    );
  }

  return {
    open,
    close,
    addName,
    removeName,
    hasName,
    getNames,
    setTip,
    getTip,
    getTips,
    setAppId,
    getAppId,
    getAppIds,
    setLastSeen,
    getLastSeen,
    getLastSeenAll,
    setLastResolved,
    getLastResolved,
    getLastResolvedAll,
    setDeactivated,
    clearDeactivated,
    getDeactivatedNames,
    importState,
  };
}
