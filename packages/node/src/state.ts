import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface PinnerState {
  knownNames: string[];
  tips: Record<string, string>;
  /** Maps ipnsName → appId for re-announcing. */
  nameToAppId?: Record<string, string>;
  /** Last activity timestamp per doc (ms epoch). */
  lastSeenAt?: Record<string, number>;
}

export async function loadState(path: string): Promise<PinnerState> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as PinnerState;
  } catch {
    return { knownNames: [], tips: {} };
  }
}

export async function saveState(
  path: string,
  state: PinnerState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}
