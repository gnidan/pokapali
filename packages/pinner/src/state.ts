import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HistoryEntry } from "./history.js";

export interface PinnerState {
  discoveredNames: string[];
  history: Record<string, HistoryEntry>;
}

const EMPTY_STATE: PinnerState = {
  discoveredNames: [],
  history: {},
};

export async function loadState(
  path: string
): Promise<PinnerState> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as PinnerState;
  } catch {
    return { ...EMPTY_STATE, history: {} };
  }
}

export async function saveState(
  path: string,
  state: PinnerState
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}
