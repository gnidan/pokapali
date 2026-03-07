import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./state.js";

describe("state persistence", () => {
  it("returns empty state for missing file", async () => {
    const path = join(
      tmpdir(),
      `pinner-test-${Date.now()}`,
      "state.json"
    );
    const state = await loadState(path);
    expect(state.discoveredNames).toEqual([]);
    expect(state.history).toEqual({});
  });

  it("round-trips state", async () => {
    const path = join(
      tmpdir(),
      `pinner-test-${Date.now()}`,
      "state.json"
    );
    const state = {
      discoveredNames: ["name1", "name2"],
      history: {
        name1: {
          tip: { cid: "bafy123", ts: 1000 },
          snapshots: [
            { cid: "bafy123", ts: 1000 },
          ],
        },
      },
    };

    await saveState(path, state);
    const loaded = await loadState(path);

    expect(loaded.discoveredNames).toEqual(
      ["name1", "name2"]
    );
    expect(loaded.history.name1.tip!.cid).toBe(
      "bafy123"
    );
  });
});
