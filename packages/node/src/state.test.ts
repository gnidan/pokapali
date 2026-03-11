import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { loadState, saveState } from "./state.js";

function tempPath(): string {
  return join(
    tmpdir(),
    `node-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    "state.json",
  );
}

async function writeRaw(path: string, content: string) {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

describe("state persistence", () => {
  it("returns empty state for missing file", async () => {
    const state = await loadState(tempPath());
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("round-trips state", async () => {
    const path = tempPath();
    const state = {
      knownNames: ["name1", "name2"],
      tips: { name1: "bafy123" },
    };

    await saveState(path, state);
    const loaded = await loadState(path);

    expect(loaded.knownNames).toEqual(["name1", "name2"]);
    expect(loaded.tips.name1).toBe("bafy123");
  });

  it("round-trips optional fields", async () => {
    const path = tempPath();
    const state = {
      knownNames: ["n1"],
      tips: { n1: "cid1" },
      nameToAppId: { n1: "app-1" },
      lastSeenAt: { n1: 1700000000000 },
    };

    await saveState(path, state);
    const loaded = await loadState(path);

    expect(loaded.nameToAppId).toEqual({ n1: "app-1" });
    expect(loaded.lastSeenAt).toEqual({
      n1: 1700000000000,
    });
  });
});

describe("state validation", () => {
  it("falls back on empty object {}", async () => {
    const path = tempPath();
    await writeRaw(path, "{}");
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("falls back on invalid JSON", async () => {
    const path = tempPath();
    await writeRaw(path, "not json {{{");
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("falls back on JSON array", async () => {
    const path = tempPath();
    await writeRaw(path, "[1, 2, 3]");
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("falls back on null", async () => {
    const path = tempPath();
    await writeRaw(path, "null");
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("falls back when knownNames is not an array", async () => {
    const path = tempPath();
    await writeRaw(
      path,
      JSON.stringify({
        knownNames: "not-array",
        tips: {},
      }),
    );
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("falls back when tips is missing", async () => {
    const path = tempPath();
    await writeRaw(path, JSON.stringify({ knownNames: ["n1"] }));
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("falls back when tips is an array", async () => {
    const path = tempPath();
    await writeRaw(
      path,
      JSON.stringify({
        knownNames: ["n1"],
        tips: ["not", "an", "object"],
      }),
    );
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("falls back when tips is null", async () => {
    const path = tempPath();
    await writeRaw(
      path,
      JSON.stringify({
        knownNames: ["n1"],
        tips: null,
      }),
    );
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });

  it("accepts partial state (has knownNames + tips)", async () => {
    const path = tempPath();
    await writeRaw(
      path,
      JSON.stringify({
        knownNames: ["n1"],
        tips: { n1: "cid1" },
      }),
    );
    const state = await loadState(path);
    expect(state.knownNames).toEqual(["n1"]);
    expect(state.tips).toEqual({ n1: "cid1" });
    // Optional fields should be undefined
    expect(state.nameToAppId).toBeUndefined();
    expect(state.lastSeenAt).toBeUndefined();
  });

  it("falls back on empty string file", async () => {
    const path = tempPath();
    await writeRaw(path, "");
    const state = await loadState(path);
    expect(state.knownNames).toEqual([]);
    expect(state.tips).toEqual({});
  });
});
