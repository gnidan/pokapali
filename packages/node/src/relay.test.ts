import {
  describe,
  it,
  expect,
} from "vitest";
import {
  encodeNodeCaps,
  decodeNodeCaps,
  appIdToCID,
  NODE_CAPS_TOPIC,
  type NodeCapabilities,
} from "./relay.js";

describe("NODE_CAPS_TOPIC", () => {
  it("is the expected topic string", () => {
    expect(NODE_CAPS_TOPIC).toBe(
      "pokapali._node-caps._p2p._pubsub",
    );
  });
});

describe("encodeNodeCaps / decodeNodeCaps", () => {
  it("roundtrips v2 caps with all fields", () => {
    const caps: NodeCapabilities = {
      version: 2,
      peerId: "12D3KooWTest",
      roles: ["relay", "pinner"],
      neighbors: [
        { peerId: "12D3KooWOther", role: "relay" },
      ],
      browserCount: 5,
      addrs: [
        "/ip4/1.2.3.4/tcp/4003/tls/ws",
      ],
    };
    const encoded = encodeNodeCaps(caps);
    const decoded = decodeNodeCaps(encoded);
    expect(decoded).toEqual(caps);
  });

  it("roundtrips v2 caps without optional fields",
    () => {
      const caps: NodeCapabilities = {
        version: 2,
        peerId: "12D3KooWMinimal",
        roles: ["relay"],
      };
      const encoded = encodeNodeCaps(caps);
      const decoded = decodeNodeCaps(encoded);
      expect(decoded).toEqual(caps);
    },
  );

  it("roundtrips empty roles array", () => {
    const caps: NodeCapabilities = {
      version: 2,
      peerId: "12D3KooWEmpty",
      roles: [],
    };
    const encoded = encodeNodeCaps(caps);
    const decoded = decodeNodeCaps(encoded);
    expect(decoded).toEqual(caps);
  });
});

describe("decodeNodeCaps", () => {
  it("accepts version 1 caps", () => {
    const v1 = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        peerId: "12D3KooWV1",
        roles: ["relay"],
      }),
    );
    const result = decodeNodeCaps(v1);
    expect(result).not.toBeNull();
    expect(result!.peerId).toBe("12D3KooWV1");
  });

  it("returns null for version 0", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        version: 0,
        peerId: "12D3KooWBad",
        roles: ["relay"],
      }),
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for version 3", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        version: 3,
        peerId: "12D3KooWBad",
        roles: ["relay"],
      }),
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for missing version", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        peerId: "12D3KooWBad",
        roles: ["relay"],
      }),
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for missing peerId", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        roles: ["relay"],
      }),
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for non-string peerId", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        peerId: 42,
        roles: ["relay"],
      }),
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for missing roles", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        peerId: "12D3KooWBad",
      }),
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for non-array roles", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        peerId: "12D3KooWBad",
        roles: "relay",
      }),
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const data = new TextEncoder().encode(
      "not json at all",
    );
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for empty data", () => {
    const data = new Uint8Array(0);
    expect(decodeNodeCaps(data)).toBeNull();
  });

  it("returns null for binary garbage", () => {
    const data = new Uint8Array([0xff, 0xfe, 0x00]);
    expect(decodeNodeCaps(data)).toBeNull();
  });
});

describe("appIdToCID", () => {
  it("returns a CID", async () => {
    const cid = await appIdToCID("test-app");
    expect(cid).toBeDefined();
    expect(cid.toString()).toMatch(/^b/); // CIDv1
  });

  it("is deterministic", async () => {
    const a = await appIdToCID("my-app");
    const b = await appIdToCID("my-app");
    expect(a.toString()).toBe(b.toString());
  });

  it("produces different CIDs for different appIds",
    async () => {
      const a = await appIdToCID("app-one");
      const b = await appIdToCID("app-two");
      expect(a.toString()).not.toBe(b.toString());
    },
  );

  it("uses RAW codec (0x55)", async () => {
    const cid = await appIdToCID("test");
    expect(cid.code).toBe(0x55);
  });

  it("uses CIDv1", async () => {
    const cid = await appIdToCID("test");
    expect(cid.version).toBe(1);
  });
});
