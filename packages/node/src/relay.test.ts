import { describe, it, expect } from "vitest";
import {
  encodeNodeCaps,
  decodeNodeCaps,
  appIdToCID,
  deriveHttpUrl,
  deriveHttpUrlFromCert,
  NODE_CAPS_TOPIC,
  type NodeCapabilities,
} from "./relay.js";

describe("NODE_CAPS_TOPIC", () => {
  it("is the expected topic string", () => {
    expect(NODE_CAPS_TOPIC).toBe("pokapali._node-caps._p2p._pubsub");
  });
});

describe("encodeNodeCaps / decodeNodeCaps", () => {
  it("roundtrips v2 caps with all fields", () => {
    const caps: NodeCapabilities = {
      version: 2,
      peerId: "12D3KooWTest",
      roles: ["relay", "pinner"],
      neighbors: [{ peerId: "12D3KooWOther", role: "relay" }],
      browserCount: 5,
      addrs: ["/ip4/1.2.3.4/tcp/4003/tls/ws"],
    };
    const encoded = encodeNodeCaps(caps);
    const decoded = decodeNodeCaps(encoded);
    expect(decoded).toEqual(caps);
  });

  it("roundtrips v2 caps without optional fields", () => {
    const caps: NodeCapabilities = {
      version: 2,
      peerId: "12D3KooWMinimal",
      roles: ["relay"],
    };
    const encoded = encodeNodeCaps(caps);
    const decoded = decodeNodeCaps(encoded);
    expect(decoded).toEqual(caps);
  });

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
    const data = new TextEncoder().encode("not json at all");
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

describe("deriveHttpUrl", () => {
  it("extracts hostname from dns4 WSS multiaddr", () => {
    const ma = "/dns4/1-2-3-4.xxx.libp2p.direct" + "/tcp/4003/tls/ws";
    expect(deriveHttpUrl(ma, 4443)).toBe(
      "https://1-2-3-4.xxx.libp2p.direct:4443",
    );
  });

  it("uses custom port", () => {
    const ma = "/dns4/host.example.com/tcp/4003/tls/ws";
    expect(deriveHttpUrl(ma, 9443)).toBe("https://host.example.com:9443");
  });

  it("extracts hostname from SNI multiaddr", () => {
    const ma =
      "/ip4/144.202.54.236/tcp/4003/tls/sni/" +
      "144-202-54-236.k51qzi.libp2p.direct/ws";
    expect(deriveHttpUrl(ma, 4443)).toBe(
      "https://144-202-54-236.k51qzi.libp2p.direct:4443",
    );
  });

  it("returns undefined for non-tls multiaddr", () => {
    const ma = "/ip4/1.2.3.4/tcp/4003/ws";
    expect(deriveHttpUrl(ma, 4443)).toBeUndefined();
  });

  it("handles dns6 multiaddr", () => {
    const ma = "/dns6/host.example.com/tcp/4003/tls/ws";
    expect(deriveHttpUrl(ma, 4443)).toBe("https://host.example.com:4443");
  });
});

describe("deriveHttpUrlFromCert", () => {
  // Minimal PEM-like string with SAN embedded
  const certPem =
    "-----BEGIN CERTIFICATE-----\n" +
    "DNS:*.k51qzi5uqu5dm7cjrpbk5wfo0src7j41ed0e" +
    "2x7njwmjy8equ05i1w0p9lqs9p.libp2p.direct\n" +
    "-----END CERTIFICATE-----";
  const domain =
    "k51qzi5uqu5dm7cjrpbk5wfo0src7j41ed0e" +
    "2x7njwmjy8equ05i1w0p9lqs9p.libp2p.direct";

  it("derives URL from cert SAN and public IP", () => {
    const addrs = ["/ip4/144.202.54.236/tcp/4001/p2p/12D3KooWTest"];
    expect(deriveHttpUrlFromCert(certPem, addrs, 4443)).toBe(
      `https://144-202-54-236.${domain}:4443`,
    );
  });

  it("skips circuit relay addrs", () => {
    const addrs = [
      "/ip4/1.2.3.4/tcp/4001/p2p/X/p2p-circuit/p2p/Y",
      "/ip4/5.6.7.8/tcp/4001/p2p/12D3KooWTest",
    ];
    expect(deriveHttpUrlFromCert(certPem, addrs, 4443)).toBe(
      `https://5-6-7-8.${domain}:4443`,
    );
  });

  it("skips localhost", () => {
    const addrs = ["/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWTest"];
    expect(deriveHttpUrlFromCert(certPem, addrs, 4443)).toBeUndefined();
  });

  it("returns undefined without cert SAN", () => {
    const addrs = ["/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest"];
    expect(deriveHttpUrlFromCert("no-san-here", addrs, 4443)).toBeUndefined();
  });
});

describe("httpUrl in caps", () => {
  it("roundtrips httpUrl field", () => {
    const caps: NodeCapabilities = {
      version: 2,
      peerId: "12D3KooWTest",
      roles: ["relay"],
      httpUrl: "https://1-2-3-4.xxx.libp2p.direct:4443",
    };
    const encoded = encodeNodeCaps(caps);
    const decoded = decodeNodeCaps(encoded);
    expect(decoded!.httpUrl).toBe("https://1-2-3-4.xxx.libp2p.direct:4443");
  });

  it("omits httpUrl when undefined", () => {
    const caps: NodeCapabilities = {
      version: 2,
      peerId: "12D3KooWTest",
      roles: ["relay"],
    };
    const encoded = encodeNodeCaps(caps);
    const decoded = decodeNodeCaps(encoded);
    expect(decoded!.httpUrl).toBeUndefined();
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

  it("produces different CIDs for different appIds", async () => {
    const a = await appIdToCID("app-one");
    const b = await appIdToCID("app-two");
    expect(a.toString()).not.toBe(b.toString());
  });

  it("uses RAW codec (0x55)", async () => {
    const cid = await appIdToCID("test");
    expect(cid.code).toBe(0x55);
  });

  it("uses CIDv1", async () => {
    const cid = await appIdToCID("test");
    expect(cid.version).toBe(1);
  });
});
