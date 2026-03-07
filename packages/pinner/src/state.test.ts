import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./state.js";

describe("state persistence", () => {
  it("returns empty state for missing file", async () => {
    const path = join(tmpdir(), `pinner-test-${Date.now()}`, "state.json");
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("round-trips state", async () => {
    const path = join(tmpdir(), `pinner-test-${Date.now()}`, "state.json");
    const state = {
      knownNames: ["name1", "name2"],
      tips: { name1: "bafy123" },
    };

    await saveState(path, state);
    const loaded = await loadState(path);

    expect(loaded.knownNames).toEqual(["name1", "name2"]);
    expect(loaded.tips.name1).toBe("bafy123");
  });
});
