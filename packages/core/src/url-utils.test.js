import { describe, it, expect } from "vitest";
import { truncateUrl, docIdFromUrl, } from "./url-utils.js";
describe("truncateUrl", () => {
    it("truncates long hash fragments", () => {
        const url = "http://localhost:3141/doc/abc123" +
            "#" + "a".repeat(64);
        const result = truncateUrl(url);
        expect(result).toContain("\u2026");
        expect(result).not.toBe(url);
        expect(result).toContain("http://localhost:3141/doc/abc123#");
    });
    it("preserves short hash fragments", () => {
        const url = "http://localhost:3141/doc/abc123#short";
        expect(truncateUrl(url)).toBe(url);
    });
    it("preserves URLs with no hash", () => {
        const url = "http://localhost:3141/doc/abc123";
        expect(truncateUrl(url)).toBe(url);
    });
    it("returns invalid URLs unchanged", () => {
        expect(truncateUrl("not-a-url")).toBe("not-a-url");
    });
});
describe("docIdFromUrl", () => {
    it("extracts and truncates the IPNS name", () => {
        const url = "http://localhost:3141/doc/" +
            "abcdef1234567890abcdef" +
            "#fragment";
        const result = docIdFromUrl(url);
        expect(result).toBe("abcdef\u2026abcdef");
    });
    it("returns short IDs untruncated", () => {
        const url = "http://localhost:3141/doc/shortid#frag";
        expect(docIdFromUrl(url)).toBe("shortid");
    });
    it("returns 'unknown' for non-doc URLs", () => {
        expect(docIdFromUrl("http://localhost:3141/other")).toBe("unknown");
    });
    it("returns 'unknown' for invalid URLs", () => {
        expect(docIdFromUrl("not-a-url")).toBe("unknown");
    });
    it("handles base path before /doc/", () => {
        const url = "http://localhost:3141/app/doc/" +
            "someid#frag";
        expect(docIdFromUrl(url)).toBe("someid");
    });
});
//# sourceMappingURL=url-utils.test.js.map