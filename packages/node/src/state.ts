import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "@pokapali/log";

const log = createLogger("state");

export interface PinnerState {
  knownNames: string[];
  tips: Record<string, string>;
  /** Maps ipnsName → appId for re-announcing. */
  nameToAppId?: Record<string, string>;
  /** Last activity timestamp per doc (ms epoch). */
  lastSeenAt?: Record<string, number>;
}

const FALLBACK: PinnerState = {
  knownNames: [],
  tips: {},
};

/**
 * Validate that parsed JSON has the expected shape.
 * Returns a valid PinnerState or null if malformed.
 */
function validateState(obj: unknown): PinnerState | null {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.knownNames)) return null;
  if (typeof o.tips !== "object" || o.tips == null || Array.isArray(o.tips)) {
    return null;
  }
  return o as unknown as PinnerState;
}

export async function loadState(path: string): Promise<PinnerState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    log.info("no state file at", path, "— starting fresh");
    return { ...FALLBACK };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      "state file corrupt (invalid JSON),",
      "starting fresh:",
      (err as Error).message,
    );
    return { ...FALLBACK };
  }

  const state = validateState(parsed);
  if (!state) {
    log.warn(
      "state file malformed (missing knownNames",
      "or tips), starting fresh",
    );
    return { ...FALLBACK };
  }

  return state;
}

export async function saveState(
  path: string,
  state: PinnerState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}
