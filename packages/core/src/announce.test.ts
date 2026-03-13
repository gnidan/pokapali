import { describe, it, expect, vi } from "vitest";
import {
  announceTopic,
  announceSnapshot,
  announceAck,
  parseAnnouncement,
  publishGuaranteeQuery,
  parseGuaranteeResponse,
} from "./announce.js";
import type { AnnouncePubSub } from "./announce.js";

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
    const pubsub: AnnouncePubSub = {
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
    const pubsub: AnnouncePubSub = {
      publish: mockPublish,
    };

    await announceAck(
      pubsub,
      "test-app",
      "abc123",
      "bafyexample",
      "peer-id-123",
    );

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
    const data = new TextEncoder().encode(
      JSON.stringify({
        ipnsName: "abc",
        cid: "bafyfoo",
      }),
    );
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
    const data = new TextEncoder().encode(
      JSON.stringify({ ipnsName: 123, cid: "ok" }),
    );
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
    const data = new TextEncoder().encode(
      JSON.stringify({
        ipnsName: "abc",
        cid: "bafyfoo",
        ack: { peerId: "peer123" },
      }),
    );
    const result = parseAnnouncement(data);
    expect(result).toEqual({
      ipnsName: "abc",
      cid: "bafyfoo",
      ack: { peerId: "peer123" },
    });
    expect(result?.ack?.peerId).toBe("peer123");
  });

  it("rejects messages exceeding MAX_MESSAGE_BYTES", () => {
    // 2MB+ message should be rejected before parsing
    const huge = new Uint8Array(2 * 1024 * 1024 + 1);
    const json = JSON.stringify({
      ipnsName: "abc",
      cid: "bafyfoo",
    });
    const encoded = new TextEncoder().encode(json);
    // Fill beginning with valid JSON, rest with padding
    huge.set(encoded, 0);
    expect(parseAnnouncement(huge)).toBeNull();
  });

  it("rejects announcements with oversized inline block", () => {
    // Block field decodes to > 1MB
    const bigBlock = new Uint8Array(1024 * 1024 + 1);
    // base64 encode it
    let binary = "";
    for (let i = 0; i < bigBlock.length; i++) {
      binary += String.fromCharCode(bigBlock[i]);
    }
    const b64 = btoa(binary);
    const data = new TextEncoder().encode(
      JSON.stringify({
        ipnsName: "abc",
        cid: "bafyfoo",
        block: b64,
      }),
    );
    const result = parseAnnouncement(data);
    // Block stripped but announcement kept for CID
    expect(result).not.toBeNull();
    expect(result!.block).toBeUndefined();
    expect(result!.cid).toBe("bafyfoo");
  });
});

describe("parseGuaranteeResponse (size limits)", () => {
  it("rejects oversized guarantee responses", () => {
    const huge = new Uint8Array(2 * 1024 * 1024 + 1);
    expect(parseGuaranteeResponse(huge)).toBeNull();
  });
});

describe("publishGuaranteeQuery", () => {
  it("publishes query on the announce topic", async () => {
    const mockPublish = vi.fn().mockResolvedValue(undefined);
    const pubsub: AnnouncePubSub = {
      publish: mockPublish,
    };

    await publishGuaranteeQuery(pubsub, "test-app", "abc123");

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [topic, data] = mockPublish.mock.calls[0];
    expect(topic).toBe("/pokapali/app/test-app/announce");
    const parsed = JSON.parse(new TextDecoder().decode(data));
    expect(parsed).toEqual({
      type: "guarantee-query",
      ipnsName: "abc123",
    });
  });
});

describe("parseGuaranteeResponse", () => {
  it("parses valid guarantee response", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        type: "guarantee-response",
        ipnsName: "abc",
        peerId: "pinner-1",
        cid: "bafyfoo",
        guaranteeUntil: 1700000000000,
        retainUntil: 1600000000000,
      }),
    );
    const result = parseGuaranteeResponse(data);
    expect(result).toEqual({
      type: "guarantee-response",
      ipnsName: "abc",
      peerId: "pinner-1",
      cid: "bafyfoo",
      guaranteeUntil: 1700000000000,
      retainUntil: 1600000000000,
    });
  });

  it("returns null for non-response type", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        type: "guarantee-query",
        ipnsName: "abc",
      }),
    );
    expect(parseGuaranteeResponse(data)).toBeNull();
  });

  it("returns null for missing fields", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        type: "guarantee-response",
        ipnsName: "abc",
        // missing peerId and cid
      }),
    );
    expect(parseGuaranteeResponse(data)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const data = new TextEncoder().encode("not json");
    expect(parseGuaranteeResponse(data)).toBeNull();
  });

  it("parses without optional fields", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        type: "guarantee-response",
        ipnsName: "abc",
        peerId: "pinner-1",
        cid: "bafyfoo",
      }),
    );
    const result = parseGuaranteeResponse(data);
    expect(result).not.toBeNull();
    expect(result!.guaranteeUntil).toBeUndefined();
    expect(result!.retainUntil).toBeUndefined();
  });
});
