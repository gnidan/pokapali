import { describe, it, expect, vi } from "vitest";
import { capitalize, formatAge } from "./utils.js";

describe("capitalize", () => {
  it("capitalizes first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  it("returns empty string unchanged", () => {
    expect(capitalize("")).toBe("");
  });

  it("leaves already-capitalized string", () => {
    expect(capitalize("World")).toBe("World");
  });

  it("handles single character", () => {
    expect(capitalize("a")).toBe("A");
  });
});

describe("formatAge", () => {
  it("returns 'just now' for <5 seconds", () => {
    const now = Date.now();
    expect(formatAge(now)).toBe("just now");
    expect(formatAge(now - 4000)).toBe("just now");
  });

  it("returns seconds for 5-59s", () => {
    const now = Date.now();
    expect(formatAge(now - 10_000)).toBe("10s ago");
    expect(formatAge(now - 59_000)).toBe("59s ago");
  });

  it("returns minutes for 60s-59min", () => {
    const now = Date.now();
    expect(formatAge(now - 60_000)).toBe("1m ago");
    expect(formatAge(now - 30 * 60_000)).toBe("30m ago");
  });

  it("returns hours for 1h-23h", () => {
    const now = Date.now();
    expect(formatAge(now - 3600_000)).toBe("1h ago");
    expect(formatAge(now - 12 * 3600_000)).toBe("12h ago");
  });

  it("returns days for 24h+", () => {
    const now = Date.now();
    expect(formatAge(now - 86400_000)).toBe("1d ago");
    expect(formatAge(now - 7 * 86400_000)).toBe("7d ago");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(formatAge(Date.now() + 10_000)).toBe("just now");
  });
});
