import { describe, it, expect } from "vitest";
import { truncateUrl } from "./url-utils.js";

describe("truncateUrl", () => {
  it("truncates long hash fragments", () => {
    const url =
      "http://localhost:3141/doc/abc123" +
      "#" + "a".repeat(64);
    const result = truncateUrl(url);
    expect(result).toContain("\u2026");
    expect(result).not.toBe(url);
    expect(result).toContain(
      "http://localhost:3141/doc/abc123#",
    );
  });

  it("preserves short hash fragments", () => {
    const url =
      "http://localhost:3141/doc/abc123#short";
    expect(truncateUrl(url)).toBe(url);
  });

  it("preserves URLs with no hash", () => {
    const url =
      "http://localhost:3141/doc/abc123";
    expect(truncateUrl(url)).toBe(url);
  });

  it("returns invalid URLs unchanged", () => {
    expect(truncateUrl("not-a-url")).toBe(
      "not-a-url",
    );
  });
});
