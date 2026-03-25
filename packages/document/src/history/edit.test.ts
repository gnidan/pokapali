import { describe, it, expect } from "vitest";
import { Edit } from "./edit.js";
import type { Origin } from "./edit.js";

describe("Edit.create", () => {
  it("constructs with all fields", () => {
    const e = Edit.create({
      payload: new Uint8Array([1, 2]),
      timestamp: 1000,
      author: "aabb",
      channel: "content",
      origin: "local",
      signature: new Uint8Array([3, 4]),
    });

    expect(e.payload).toEqual(new Uint8Array([1, 2]));
    expect(e.timestamp).toBe(1000);
    expect(e.author).toBe("aabb");
    expect(e.channel).toBe("content");
    expect(e.origin).toBe("local");
    expect(e.signature).toEqual(new Uint8Array([3, 4]));
  });

  it("supports all origin types", () => {
    const origins: Origin[] = ["local", "sync", "hydrate"];
    for (const origin of origins) {
      const e = Edit.create({
        payload: new Uint8Array([1]),
        timestamp: 1000,
        author: "aa",
        channel: "content",
        origin,
        signature: new Uint8Array([]),
      });
      expect(e.origin).toBe(origin);
    }
  });
});
