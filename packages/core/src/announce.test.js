import { describe, it, expect, vi } from "vitest";
import { announceTopic, announceSnapshot, announceAck, parseAnnouncement, } from "./announce.js";
describe("announceTopic", () => {
    it("returns the expected topic format", () => {
        expect(announceTopic("my-app")).toBe("/pokapali/app/my-app/announce");
    });
    it("handles empty appId", () => {
        expect(announceTopic("")).toBe("/pokapali/app//announce");
    });
});
describe("announceSnapshot", () => {
    it("publishes JSON on the correct topic", async () => {
        const mockPublish = vi.fn().mockResolvedValue(undefined);
        const pubsub = {
            publish: mockPublish,
        };
        await announceSnapshot(pubsub, "test-app", "abc123", "bafyexample");
        expect(mockPublish).toHaveBeenCalledTimes(1);
        const [topic, data] = mockPublish.mock.calls[0];
        expect(topic).toBe("/pokapali/app/test-app/announce");
        const parsed = JSON.parse(new TextDecoder().decode(data));
        expect(parsed).toEqual({
            ipnsName: "abc123",
            cid: "bafyexample",
        });
    });
});
describe("announceAck", () => {
    it("publishes ack JSON on the correct topic", async () => {
        const mockPublish = vi.fn().mockResolvedValue(undefined);
        const pubsub = {
            publish: mockPublish,
        };
        await announceAck(pubsub, "test-app", "abc123", "bafyexample", "peer-id-123");
        expect(mockPublish).toHaveBeenCalledTimes(1);
        const [topic, data] = mockPublish.mock.calls[0];
        expect(topic).toBe("/pokapali/app/test-app/announce");
        const parsed = JSON.parse(new TextDecoder().decode(data));
        expect(parsed).toEqual({
            ipnsName: "abc123",
            cid: "bafyexample",
            ack: { peerId: "peer-id-123" },
        });
    });
});
describe("parseAnnouncement", () => {
    it("parses valid announcement", () => {
        const data = new TextEncoder().encode(JSON.stringify({
            ipnsName: "abc",
            cid: "bafyfoo",
        }));
        const result = parseAnnouncement(data);
        expect(result).toEqual({
            ipnsName: "abc",
            cid: "bafyfoo",
        });
    });
    it("returns null for missing fields", () => {
        const data = new TextEncoder().encode(JSON.stringify({ ipnsName: "abc" }));
        expect(parseAnnouncement(data)).toBeNull();
    });
    it("returns null for non-string fields", () => {
        const data = new TextEncoder().encode(JSON.stringify({ ipnsName: 123, cid: "ok" }));
        expect(parseAnnouncement(data)).toBeNull();
    });
    it("returns null for invalid JSON", () => {
        const data = new TextEncoder().encode("not json");
        expect(parseAnnouncement(data)).toBeNull();
    });
    it("returns null for empty data", () => {
        expect(parseAnnouncement(new Uint8Array(0))).toBeNull();
    });
    it("parses ack announcement", () => {
        const data = new TextEncoder().encode(JSON.stringify({
            ipnsName: "abc",
            cid: "bafyfoo",
            ack: { peerId: "peer123" },
        }));
        const result = parseAnnouncement(data);
        expect(result).toEqual({
            ipnsName: "abc",
            cid: "bafyfoo",
            ack: { peerId: "peer123" },
        });
        expect(result?.ack?.peerId).toBe("peer123");
    });
});
//# sourceMappingURL=announce.test.js.map