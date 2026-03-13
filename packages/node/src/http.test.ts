import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { startHttpServer, startBlockServer, readBody } from "./http.js";
import type { HttpConfig, HttpsConfig } from "./http.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// Minimal mock relay that satisfies the interface
// used by getHealthData / getStatusData / metrics.
function mockRelay(opts?: {
  peerId?: string;
  connections?: number;
  peers?: number;
  /** Peer IDs for connections (for remotePeer). */
  connectedPeerIds?: string[];
  multiaddrs?: string[];
  topics?: string[];
  gsPeers?: number;
  /** Map of topic → subscriber peer IDs. */
  subscribers?: Record<string, string[]>;
  /** Map of topic → mesh peer IDs. */
  meshPeers?: Record<string, string[]>;
  /** Map of peer ID → score. */
  peerScores?: Record<string, number>;
  /** Map of topic → Map of peer ID → backoff
   *  expiry (ms epoch). */
  backoff?: Record<string, Record<string, number>>;
  /** Set of peer IDs with outbound streams. */
  streamsOutbound?: string[];
}) {
  const pid = opts?.peerId ?? "12D3KooWTestPeer";
  const connPids = opts?.connectedPeerIds ?? [];
  const connCount = opts?.connections ?? (connPids.length || 2);
  const conns =
    connPids.length > 0
      ? connPids.map((p) => ({
          remotePeer: { toString: () => p },
        }))
      : Array.from({ length: connCount }, () => ({
          remotePeer: { toString: () => "unknown" },
        }));
  const peers = Array.from({ length: opts?.peers ?? 3 }, () => ({}));
  const addrs = (opts?.multiaddrs ?? []).map((a) => ({ toString: () => a }));
  const topics = opts?.topics ?? [];
  const gsPeers = Array.from({ length: opts?.gsPeers ?? 0 }, () => ({}));
  const subs = opts?.subscribers ?? {};
  const mesh = new Map<string, Set<string>>();
  for (const [t, pids] of Object.entries(opts?.meshPeers ?? {})) {
    mesh.set(t, new Set(pids));
  }

  const peerScores = opts?.peerScores ?? {};
  const backoff = new Map<string, Map<string, number>>();
  for (const [t, peers] of Object.entries(opts?.backoff ?? {})) {
    backoff.set(t, new Map(Object.entries(peers)));
  }
  const streamsOut = new Map<string, unknown>();
  for (const p of opts?.streamsOutbound ?? []) {
    streamsOut.set(p, {});
  }

  return {
    peerId: () => pid,
    multiaddrs: () => opts?.multiaddrs ?? [],
    helia: {
      libp2p: {
        getConnections: () => conns,
        getPeers: () => peers,
        getMultiaddrs: () => addrs,
        services: {
          pubsub: {
            getTopics: () => topics,
            getPeers: () => gsPeers,
            getSubscribers: (topic: string) =>
              (subs[topic] ?? []).map((p: string) => ({ toString: () => p })),
            getMeshPeers: (topic: string) =>
              [...(mesh.get(topic) ?? [])].map((p) => ({ toString: () => p })),
            backoff,
            streamsOutbound: streamsOut,
            score: {
              score: (peerId: string) => peerScores[peerId] ?? 0,
            },
          },
        },
      },
    },
  } as any;
}

// Minimal mock pinner
function mockPinner(opts?: {
  ingestResult?: boolean;
  metrics?: Record<string, unknown>;
}) {
  return {
    ingest: async () => opts?.ingestResult ?? true,
    metrics: () =>
      opts?.metrics ?? {
        knownNames: 10,
        tipsTracked: 10,
        acksTracked: 5,
      },
  } as any;
}

// Helper to make HTTP requests to the test server
function fetch(
  port: number,
  method: string,
  path: string,
  body?: Buffer,
): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: body ? { "content-length": body.length } : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("startHttpServer", () => {
  let server: Server;
  let port: number;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  function start(config: Partial<HttpConfig> = {}) {
    // Use port 0 for random available port
    const cfg: HttpConfig = {
      port: 0,
      relay: config.relay ?? null,
      pinner: config.pinner ?? null,
      pinAppIds: config.pinAppIds ?? [],
      ...config,
    };
    server = startHttpServer(cfg);
    const addr = server.address() as any;
    port = addr.port;
  }

  describe("GET /health", () => {
    it("returns health data with relay", async () => {
      start({ relay: mockRelay() });
      const res = await fetch(port, "GET", "/health");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.peerId).toBe("12D3KooWTestPeer");
      expect(data.peers).toBe(3);
      expect(data.connections).toBe(2);
      expect(typeof data.uptime).toBe("number");
    });

    it("returns null peerId without relay", async () => {
      start();
      const res = await fetch(port, "GET", "/health");
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.peerId).toBeNull();
      expect(data.peers).toBe(0);
      expect(data.connections).toBe(0);
    });
  });

  describe("GET /status", () => {
    it("shows relay+pin mode", async () => {
      start({
        relay: mockRelay(),
        pinner: mockPinner(),
        pinAppIds: ["app-a", "app-b"],
      });
      const res = await fetch(port, "GET", "/status");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.mode).toBe("relay+pin");
      expect(data.pinApps).toEqual(["app-a", "app-b"]);
      expect(typeof data.logLevel).toBe("string");
    });

    it("shows relay mode without pinner", async () => {
      start({ relay: mockRelay() });
      const res = await fetch(port, "GET", "/status");
      const data = JSON.parse(res.body);
      expect(data.mode).toBe("relay");
    });

    it("shows none mode without relay or pinner", async () => {
      start();
      const res = await fetch(port, "GET", "/status");
      const data = JSON.parse(res.body);
      expect(data.mode).toBe("none");
    });

    it("detects WSS from multiaddrs", async () => {
      start({
        relay: mockRelay({
          multiaddrs: ["/ip4/1.2.3.4/tcp/4003/tls/ws"],
        }),
      });
      const res = await fetch(port, "GET", "/status");
      const data = JSON.parse(res.body);
      expect(data.wss).toBe(true);
    });

    it("wss is false without TLS addrs", async () => {
      start({
        relay: mockRelay({
          multiaddrs: ["/ip4/1.2.3.4/tcp/4003/ws"],
        }),
      });
      const res = await fetch(port, "GET", "/status");
      const data = JSON.parse(res.body);
      expect(data.wss).toBe(false);
    });

    it("includes gossipsub diagnostics", async () => {
      start({
        relay: mockRelay({
          topics: ["topic-a", "topic-b"],
          gsPeers: 3,
          subscribers: {
            "topic-a": ["peer-1", "peer-2"],
            "topic-b": ["peer-3"],
          },
          meshPeers: {
            "topic-a": ["peer-1"],
            "topic-b": ["peer-3"],
          },
        }),
      });
      const res = await fetch(port, "GET", "/status");
      const data = JSON.parse(res.body);
      expect(data.gossipsub).not.toBeNull();
      expect(data.gossipsub.peers).toBe(3);
      expect(data.gossipsub.topics["topic-a"]).toEqual({
        subscribers: 2,
        mesh: 1,
      });
      expect(data.gossipsub.topics["topic-b"]).toEqual({
        subscribers: 1,
        mesh: 1,
      });
    });
  });

  describe("GET /metrics", () => {
    it("returns memory and pinner metrics", async () => {
      start({
        pinner: mockPinner({
          metrics: { knownNames: 42 },
        }),
      });
      const res = await fetch(port, "GET", "/metrics");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.memory).toHaveProperty("rss");
      expect(data.memory).toHaveProperty("heapUsed");
      expect(data.pinner.knownNames).toBe(42);
      expect(typeof data.uptime).toBe("number");
    });

    it("returns null pinner when no pinner", async () => {
      start();
      const res = await fetch(port, "GET", "/metrics");
      const data = JSON.parse(res.body);
      expect(data.pinner).toBeNull();
    });

    it("includes per-topic mesh peer details", async () => {
      start({
        relay: mockRelay({
          topics: ["topic-a"],
          gsPeers: 3,
          subscribers: {
            "topic-a": ["peer-1", "peer-2"],
          },
          meshPeers: {
            "topic-a": ["peer-1", "peer-2"],
          },
          peerScores: {
            "peer-1": 100,
            "peer-2": 0,
          },
          streamsOutbound: ["peer-1"],
        }),
      });
      const res = await fetch(port, "GET", "/metrics");
      const data = JSON.parse(res.body);
      const gs = data.gossipsub;
      expect(gs).not.toBeNull();

      const topicA = gs.topics["topic-a"];
      expect(topicA.mesh).toBe(2);
      expect(topicA.meshPeers).toHaveLength(2);

      const p1 = topicA.meshPeers.find((p: any) => p.peerId === "peer-1");
      expect(p1.score).toBe(100);
      expect(p1.hasStream).toBe(true);
      expect(p1.backoffSec).toBeNull();

      const p2 = topicA.meshPeers.find((p: any) => p.peerId === "peer-2");
      expect(p2.score).toBe(0);
      expect(p2.hasStream).toBe(false);
    });

    it("reports backoff state for mesh peers", async () => {
      const futureBackoff = Date.now() + 30_000;
      start({
        relay: mockRelay({
          topics: ["topic-a"],
          subscribers: {
            "topic-a": ["peer-1"],
          },
          meshPeers: {
            "topic-a": ["peer-1"],
          },
          backoff: {
            "topic-a": {
              "peer-1": futureBackoff,
            },
          },
        }),
      });
      const res = await fetch(port, "GET", "/metrics");
      const data = JSON.parse(res.body);
      const p1 = data.gossipsub.topics["topic-a"].meshPeers[0];
      expect(p1.backoffSec).toBeGreaterThan(0);
      expect(p1.backoffSec).toBeLessThanOrEqual(30);
    });

    it("identifies relay peers by score", async () => {
      start({
        relay: mockRelay({
          topics: ["topic-a"],
          subscribers: {
            "topic-a": ["relay-1", "browser-1"],
          },
          meshPeers: {
            "topic-a": ["relay-1", "browser-1"],
          },
          peerScores: {
            "relay-1": 100,
            "browser-1": 0,
          },
          connectedPeerIds: ["relay-1"],
        }),
      });
      const res = await fetch(port, "GET", "/metrics");
      const data = JSON.parse(res.body);
      const relays = data.gossipsub.relayPeers;
      expect(relays).toHaveLength(1);
      expect(relays[0].peerId).toBe("relay-1");
      expect(relays[0].connected).toBe(true);
      expect(relays[0].score).toBe(100);
    });

    it("shows disconnected relay peers", async () => {
      start({
        relay: mockRelay({
          topics: ["topic-a"],
          subscribers: {
            "topic-a": ["relay-1"],
          },
          meshPeers: {
            "topic-a": ["relay-1"],
          },
          peerScores: { "relay-1": 100 },
          // relay-1 NOT in connectedPeerIds
          connectedPeerIds: [],
        }),
      });
      const res = await fetch(port, "GET", "/metrics");
      const data = JSON.parse(res.body);
      const relays = data.gossipsub.relayPeers;
      expect(relays).toHaveLength(1);
      expect(relays[0].connected).toBe(false);
    });

    it("includes score distribution", async () => {
      start({
        relay: mockRelay({
          topics: ["topic-a"],
          subscribers: {
            "topic-a": ["p1", "p2", "p3"],
          },
          meshPeers: {
            "topic-a": ["p1", "p2", "p3"],
          },
          peerScores: {
            p1: -2,
            p2: 50,
            p3: 100,
          },
        }),
      });
      const res = await fetch(port, "GET", "/metrics");
      const data = JSON.parse(res.body);
      const dist = data.gossipsub.scoreDistribution;
      expect(dist).not.toBeNull();
      expect(dist.min).toBe(-2);
      expect(dist.max).toBe(100);
      expect(dist.negative).toBe(1);
      expect(dist.count).toBe(3);
    });
  });

  describe("POST /ingest/:ipnsName", () => {
    it("accepts valid body and returns 200", async () => {
      start({ pinner: mockPinner() });
      const body = Buffer.from("snapshot-data");
      const res = await fetch(port, "POST", "/ingest/test-name", body);
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
    });

    it("returns 429 when pinner rejects", async () => {
      start({
        pinner: mockPinner({ ingestResult: false }),
      });
      const body = Buffer.from("snapshot-data");
      const res = await fetch(port, "POST", "/ingest/test-name", body);
      expect(res.status).toBe(429);
      const data = JSON.parse(res.body);
      expect(data.error).toBe("rejected");
    });

    it("returns 400 for empty body", async () => {
      start({ pinner: mockPinner() });
      const res = await fetch(
        port,
        "POST",
        "/ingest/test-name",
        Buffer.alloc(0),
      );
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toBe("empty body");
    });

    it("rejects body exceeding 6MB", async () => {
      start({ pinner: mockPinner() });
      // 6MB + 1 byte — server calls req.destroy()
      // which may reset the socket before the 413
      // response arrives. Accept either a 413
      // response or a connection error.
      const body = Buffer.alloc(6_000_001);
      try {
        const res = await fetch(port, "POST", "/ingest/test-name", body);
        expect(res.status).toBe(413);
        const data = JSON.parse(res.body);
        expect(data.error).toBe("body too large");
      } catch (err: any) {
        // "socket hang up" or "ECONNRESET" means
        // the server correctly rejected the body
        expect(
          err.message === "socket hang up" || err.code === "ECONNRESET",
        ).toBe(true);
      }
    });

    it("returns 404 when no pinner configured", async () => {
      start();
      const body = Buffer.from("data");
      const res = await fetch(port, "POST", "/ingest/test-name", body);
      expect(res.status).toBe(404);
    });

    it("validates ipnsName format", async () => {
      start({ pinner: mockPinner() });
      // Invalid chars in ipnsName
      const body = Buffer.from("data");
      const res = await fetch(port, "POST", "/ingest/bad%20name!", body);
      expect(res.status).toBe(404);
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for unknown path", async () => {
      start({ relay: mockRelay() });
      const res = await fetch(port, "GET", "/nonexistent");
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toBe("not found");
    });

    it("returns 404 for POST to /health", async () => {
      start({ relay: mockRelay() });
      const res = await fetch(port, "POST", "/health");
      expect(res.status).toBe(404);
    });
  });
});

// --- Block server tests ---

// Pre-generated EC P-256 self-signed cert for
// localhost. Test-only, expires 2036, no secrets.
// Avoids shelling out to openssl (not available
// on all CI runners).
const testKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLDwIQJlQOGL+Cvfa
2n1FOHB44GBk9B6Y5Y7bNoETaa+hRANCAAS06IJtYpYiseas9vLZQulMBwAbrvOc
AZ0JgManZxPo82/oaz2dpwSEFF2mveCNx01fsLEx0KTaDoSOCtqwcgoO
-----END PRIVATE KEY-----`;

const testCert = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUClFHl+Mfu0LohA2kkWE1cm1dDi8wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDMxMTAzNTEyOFoXDTM2MDMwODAz
NTEyOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEtOiCbWKWIrHmrPby2ULpTAcAG67znAGdCYDGp2cT6PNv6Gs9nacEhBRd
pr3gjcdNX7CxMdCk2g6EjgrasHIKDqNTMFEwHQYDVR0OBBYEFJ7pp9k7fCgmoj3f
og+myBluoevZMB8GA1UdIwQYMBaAFJ7pp9k7fCgmoj3fog+myBluoevZMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhALXKFyE4MRiTAtFJfwi8kRiQ
gjZvwQ9mCQgywml0+I0YAiBt9NvU8duWx1XGmTqpbXhRwWvdYL7CjvMjUYqgR4m5
1Q==
-----END CERTIFICATE-----`;

function fetchHttps(
  port: number,
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: Buffer,
): Promise<{
  status: number;
  body: Buffer;
  headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        rejectUnauthorized: false,
        headers: {
          ...headers,
          ...(body ? { "content-length": body.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") respHeaders[k] = v;
          }
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks),
            headers: respHeaders,
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("startBlockServer", () => {
  let server: HttpsServer;
  let port: number;

  // In-memory blockstore
  const blocks = new Map<string, Uint8Array>();

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
    blocks.clear();
  });

  function startBlock(overrides?: Partial<HttpsConfig>) {
    const cfg: HttpsConfig = {
      port: 0,
      key: testKey,
      cert: testCert,
      corsOrigin: "*",
      rateLimitRpm: 60,
      trustProxy: false,
      getBlock: async (cid) => {
        return blocks.get(cid.toString()) ?? null;
      },
      putBlock: async (cid, bytes) => {
        blocks.set(cid.toString(), bytes);
      },
      ...overrides,
    };
    server = startBlockServer(cfg);
    const addr = server.address() as any;
    port = addr.port;
  }

  async function putBlock(data: Uint8Array): Promise<CID> {
    const hash = await sha256.digest(data);
    const cid = CID.createV1(0x55, hash);
    blocks.set(cid.toString(), data);
    return cid;
  }

  it("serves a block by CID", async () => {
    startBlock();
    const data = new Uint8Array([1, 2, 3, 4]);
    const cid = await putBlock(data);
    const res = await fetchHttps(port, "GET", `/block/${cid.toString()}`);
    expect(res.status).toBe(200);
    expect([...res.body]).toEqual([1, 2, 3, 4]);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("returns 404 for missing block", async () => {
    startBlock();
    const hash = await sha256.digest(new Uint8Array([99]));
    const cid = CID.createV1(0x55, hash);
    const res = await fetchHttps(port, "GET", `/block/${cid.toString()}`);
    expect(res.status).toBe(404);
    const data = JSON.parse(res.body.toString());
    expect(data.error).toBe("block not found");
  });

  it("returns 400 for invalid CID", async () => {
    startBlock();
    const res = await fetchHttps(port, "GET", "/block/not-a-valid-cid");
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body.toString());
    expect(data.error).toBe("invalid CID");
  });

  it("returns 429 when rate limited", async () => {
    startBlock({ rateLimitRpm: 2 });
    const data = new Uint8Array([10]);
    const cid = await putBlock(data);
    const path = `/block/${cid.toString()}`;

    // Use up the limit
    await fetchHttps(port, "GET", path);
    await fetchHttps(port, "GET", path);

    const res = await fetchHttps(port, "GET", path);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
  });

  it("handles OPTIONS preflight", async () => {
    startBlock();
    const res = await fetchHttps(port, "OPTIONS", "/block/anything");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("returns CORS * by default", async () => {
    startBlock();
    const data = new Uint8Array([5]);
    const cid = await putBlock(data);
    const res = await fetchHttps(port, "GET", `/block/${cid.toString()}`);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("matches configured CORS origin", async () => {
    startBlock({
      corsOrigin: "https://a.com,https://b.com",
    });
    const data = new Uint8Array([6]);
    const cid = await putBlock(data);

    const res = await fetchHttps(port, "GET", `/block/${cid.toString()}`, {
      Origin: "https://b.com",
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://b.com");
  });

  it("omits CORS for non-matching origin", async () => {
    startBlock({ corsOrigin: "https://a.com" });
    const data = new Uint8Array([7]);
    const cid = await putBlock(data);

    const res = await fetchHttps(port, "GET", `/block/${cid.toString()}`, {
      Origin: "https://evil.com",
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns 404 for non-block paths", async () => {
    startBlock();
    const res = await fetchHttps(port, "GET", "/health");
    expect(res.status).toBe(404);
  });

  // --- POST /block/:cid tests ---

  it("stores a block via POST", async () => {
    startBlock();
    const data = new Uint8Array([10, 20, 30]);
    const hash = await sha256.digest(data);
    const cid = CID.createV1(0x55, hash);
    const path = `/block/${cid.toString()}`;

    const res = await fetchHttps(port, "POST", path, {}, Buffer.from(data));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString());
    expect(body.ok).toBe(true);

    // Verify it's now readable via GET
    const get = await fetchHttps(port, "GET", path);
    expect(get.status).toBe(200);
    expect([...get.body]).toEqual([10, 20, 30]);
  });

  it("rejects POST with CID mismatch", async () => {
    startBlock();
    const data = new Uint8Array([1, 2, 3]);
    // Use wrong data to compute CID
    const wrongHash = await sha256.digest(new Uint8Array([99]));
    const wrongCid = CID.createV1(0x55, wrongHash);

    const res = await fetchHttps(
      port,
      "POST",
      `/block/${wrongCid.toString()}`,
      {},
      Buffer.from(data),
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body.toString());
    expect(body.error).toBe("CID mismatch");
  });

  it("rejects POST with empty body", async () => {
    startBlock();
    const hash = await sha256.digest(new Uint8Array([1]));
    const cid = CID.createV1(0x55, hash);

    const res = await fetchHttps(
      port,
      "POST",
      `/block/${cid.toString()}`,
      {},
      Buffer.alloc(0),
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body.toString());
    expect(body.error).toBe("empty body");
  });

  it("rejects POST exceeding 6MB", async () => {
    startBlock();
    const hash = await sha256.digest(new Uint8Array([1]));
    const cid = CID.createV1(0x55, hash);

    try {
      const res = await fetchHttps(
        port,
        "POST",
        `/block/${cid.toString()}`,
        {},
        Buffer.alloc(6_000_001),
      );
      expect(res.status).toBe(413);
    } catch (err: any) {
      // Socket may reset before response
      expect(
        err.message === "socket hang up" || err.code === "ECONNRESET",
      ).toBe(true);
    }
  });

  it("rate limits POST requests", async () => {
    startBlock({ rateLimitRpm: 2 });
    const data = new Uint8Array([5]);
    const hash = await sha256.digest(data);
    const cid = CID.createV1(0x55, hash);
    const path = `/block/${cid.toString()}`;
    const buf = Buffer.from(data);

    // Use up the limit
    await fetchHttps(port, "POST", path, {}, buf);
    await fetchHttps(port, "POST", path, {}, buf);

    const res = await fetchHttps(port, "POST", path, {}, buf);
    expect(res.status).toBe(429);
  });

  it("OPTIONS preflight allows POST", async () => {
    startBlock();
    const res = await fetchHttps(port, "OPTIONS", "/block/anything");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST");
  });

  // --- History endpoint tests ---

  it("returns history for an IPNS name", async () => {
    const now = Date.now();
    startBlock({
      getHistory: async () => [
        { cid: "cid-old", ts: now - 2000 },
        { cid: "cid-new", ts: now },
      ],
    });
    const name = "aa".repeat(32);
    const res = await fetchHttps(port, "GET", `/history/${name}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString());
    expect(body.totalVersions).toBe(2);
    expect(body.versions).toHaveLength(2);
    // Newest first
    expect(body.versions[0].cid).toBe("cid-new");
    expect(body.versions[1].cid).toBe("cid-old");
    // Has seq numbers
    expect(body.versions[0].seq).toBe(2);
    expect(body.versions[1].seq).toBe(1);
  });

  it("paginates history with limit and before", async () => {
    const now = Date.now();
    const records = Array.from({ length: 10 }, (_, i) => ({
      cid: `cid-${i}`,
      ts: now - (9 - i) * 1000,
    }));
    startBlock({
      getHistory: async () => records,
    });
    const name = "bb".repeat(32);

    // Limit to 3
    const res1 = await fetchHttps(port, "GET", `/history/${name}?limit=3`);
    const body1 = JSON.parse(res1.body.toString());
    expect(body1.versions).toHaveLength(3);
    expect(body1.totalVersions).toBe(10);

    // before=5 gets entries with seq < 5
    const res2 = await fetchHttps(
      port,
      "GET",
      `/history/${name}?before=5&limit=2`,
    );
    const body2 = JSON.parse(res2.body.toString());
    expect(body2.versions).toHaveLength(2);
    expect(body2.versions[0].seq).toBeLessThan(5);
  });

  it("returns empty versions for unknown name", async () => {
    startBlock({
      getHistory: async () => [],
    });
    const name = "cc".repeat(32);
    const res = await fetchHttps(port, "GET", `/history/${name}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString());
    expect(body.versions).toEqual([]);
    expect(body.totalVersions).toBe(0);
  });

  it("returns 404 when no getHistory configured", async () => {
    startBlock(); // no getHistory
    const name = "dd".repeat(32);
    const res = await fetchHttps(port, "GET", `/history/${name}`);
    expect(res.status).toBe(404);
  });

  it("includes tier and retentionPolicy when configured", async () => {
    const now = Date.now();
    const MS_PER_DAY = 86400000;
    const policy = {
      fullResolutionMs: 7 * MS_PER_DAY,
      hourlyRetentionMs: 14 * MS_PER_DAY,
      dailyRetentionMs: 30 * MS_PER_DAY,
    };
    startBlock({
      getHistory: async () => [
        { cid: "cid-tip", ts: now },
        { cid: "cid-full", ts: now - 3 * MS_PER_DAY },
        {
          cid: "cid-hourly",
          ts: now - 10 * MS_PER_DAY,
        },
        {
          cid: "cid-daily",
          ts: now - 20 * MS_PER_DAY,
        },
      ],
      retentionPolicy: policy,
    });
    const name = "ee".repeat(32);
    const res = await fetchHttps(port, "GET", `/history/${name}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString());

    expect(body.retentionPolicy).toEqual(policy);
    expect(body.totalVersions).toBe(4);

    const v = body.versions;
    expect(v[0].tier).toBe("tip");
    expect(v[0].expiresAt).toBeNull();
    expect(v[1].tier).toBe("full");
    expect(v[1].expiresAt).toBeTypeOf("number");
    expect(v[2].tier).toBe("hourly");
    expect(v[3].tier).toBe("daily");
  });

  it("omits tier fields when no retentionPolicy", async () => {
    const now = Date.now();
    startBlock({
      getHistory: async () => [{ cid: "cid-a", ts: now }],
    });
    const name = "ff".repeat(32);
    const res = await fetchHttps(port, "GET", `/history/${name}`);
    const body = JSON.parse(res.body.toString());
    expect(body.retentionPolicy).toBeUndefined();
    expect(body.versions[0].tier).toBeUndefined();
    expect(body.versions[0].expiresAt).toBeUndefined();
  });

  // --- GET /tip/:ipnsName tests ---

  describe("GET /tip/:ipnsName", () => {
    const tipBlock = new Uint8Array([1, 2, 3, 4]);
    const now = Date.now();

    function mockTipData() {
      return {
        ipnsName: "aa".repeat(32),
        cid: "bafy-test-cid",
        block: tipBlock,
        seq: 5,
        ts: now,
        peerId: "12D3KooWTestPeer",
        guaranteeUntil: now + 7 * 86400000,
        retainUntil: now + 14 * 86400000,
      };
    }

    it("returns tip data with block as base64", async () => {
      const tip = mockTipData();
      startBlock({
        getTipData: async () => tip,
      });
      const name = "aa".repeat(32);
      const res = await fetchHttps(port, "GET", `/tip/${name}`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body.toString());
      expect(body.ipnsName).toBe(name);
      expect(body.cid).toBe("bafy-test-cid");
      expect(body.seq).toBe(5);
      expect(body.ts).toBe(now);
      expect(body.peerId).toBe("12D3KooWTestPeer");
      expect(body.guaranteeUntil).toBeTypeOf("number");
      expect(body.retainUntil).toBeTypeOf("number");
      // Block should be base64-encoded
      const decoded = Buffer.from(body.block, "base64");
      expect([...decoded]).toEqual([1, 2, 3, 4]);
    });

    it("returns no-cache header", async () => {
      startBlock({
        getTipData: async () => mockTipData(),
      });
      const name = "aa".repeat(32);
      const res = await fetchHttps(port, "GET", `/tip/${name}`);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 404 for unknown name", async () => {
      startBlock({
        getTipData: async () => null,
      });
      const name = "bb".repeat(32);
      const res = await fetchHttps(port, "GET", `/tip/${name}`);
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body.toString());
      expect(body.error).toBe("not found");
    });

    it("returns 404 when no getTipData configured", async () => {
      startBlock(); // no getTipData
      const name = "cc".repeat(32);
      const res = await fetchHttps(port, "GET", `/tip/${name}`);
      expect(res.status).toBe(404);
    });

    it("rejects non-hex ipnsName", async () => {
      startBlock({
        getTipData: async () => mockTipData(),
      });
      const res = await fetchHttps(port, "GET", "/tip/not-hex-name!");
      expect(res.status).toBe(404);
    });

    it("rate limits requests", async () => {
      startBlock({
        rateLimitRpm: 2,
        getTipData: async () => mockTipData(),
      });
      const name = "dd".repeat(32);
      const path = `/tip/${name}`;

      await fetchHttps(port, "GET", path);
      await fetchHttps(port, "GET", path);
      const res = await fetchHttps(port, "GET", path);
      expect(res.status).toBe(429);
    });

    it("calls recordActivity on success", async () => {
      let recorded: string | null = null;
      startBlock({
        getTipData: async () => mockTipData(),
        recordActivity: (name) => {
          recorded = name;
        },
      });
      const name = "aa".repeat(32);
      await fetchHttps(port, "GET", `/tip/${name}`);
      expect(recorded).toBe(name);
    });

    it("includes CORS headers", async () => {
      startBlock({
        getTipData: async () => mockTipData(),
      });
      const name = "aa".repeat(32);
      const res = await fetchHttps(port, "GET", `/tip/${name}`);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  // --- GET /guarantee/:ipnsName tests ---

  describe("GET /guarantee/:ipnsName", () => {
    const now = Date.now();

    function mockGuarantee() {
      return {
        ipnsName: "aa".repeat(32),
        cid: "bafy-test-cid",
        peerId: "12D3KooWTestPeer",
        guaranteeUntil: now + 7 * 86400000,
        retainUntil: now + 14 * 86400000,
      };
    }

    it("returns guarantee data", async () => {
      const g = mockGuarantee();
      startBlock({
        getGuarantee: () => g,
      });
      const name = "aa".repeat(32);
      const res = await fetchHttps(port, "GET", `/guarantee/${name}`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body.toString());
      expect(body.ipnsName).toBe(name);
      expect(body.cid).toBe("bafy-test-cid");
      expect(body.peerId).toBe("12D3KooWTestPeer");
      expect(body.guaranteeUntil).toBeTypeOf("number");
      expect(body.retainUntil).toBeTypeOf("number");
    });

    it("returns no-cache header", async () => {
      startBlock({
        getGuarantee: () => mockGuarantee(),
      });
      const name = "aa".repeat(32);
      const res = await fetchHttps(port, "GET", `/guarantee/${name}`);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 404 for unknown name", async () => {
      startBlock({
        getGuarantee: () => null,
      });
      const name = "bb".repeat(32);
      const res = await fetchHttps(port, "GET", `/guarantee/${name}`);
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body.toString());
      expect(body.error).toBe("not found");
    });

    it("returns 404 when no getGuarantee configured", async () => {
      startBlock(); // no getGuarantee
      const name = "cc".repeat(32);
      const res = await fetchHttps(port, "GET", `/guarantee/${name}`);
      expect(res.status).toBe(404);
    });

    it("rejects non-hex ipnsName", async () => {
      startBlock({
        getGuarantee: () => mockGuarantee(),
      });
      const res = await fetchHttps(port, "GET", "/guarantee/not-hex!");
      expect(res.status).toBe(404);
    });

    it("rate limits requests", async () => {
      startBlock({
        rateLimitRpm: 2,
        getGuarantee: () => mockGuarantee(),
      });
      const name = "dd".repeat(32);
      const path = `/guarantee/${name}`;

      await fetchHttps(port, "GET", path);
      await fetchHttps(port, "GET", path);
      const res = await fetchHttps(port, "GET", path);
      expect(res.status).toBe(429);
    });

    it("calls recordActivity on success", async () => {
      let recorded: string | null = null;
      startBlock({
        getGuarantee: () => mockGuarantee(),
        recordActivity: (name) => {
          recorded = name;
        },
      });
      const name = "aa".repeat(32);
      await fetchHttps(port, "GET", `/guarantee/${name}`);
      expect(recorded).toBe(name);
    });

    it("includes CORS headers", async () => {
      startBlock({
        getGuarantee: () => mockGuarantee(),
      });
      const name = "aa".repeat(32);
      const res = await fetchHttps(port, "GET", `/guarantee/${name}`);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });
});

// --- readBody unit tests ---

describe("readBody", () => {
  function createMockStream(
    chunks: Buffer[],
    delayMs?: number,
  ): AsyncIterable<Buffer> & { destroy(): void } {
    let destroyed = false;
    return {
      destroy() {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          if (destroyed) {
            throw new Error("stream destroyed");
          }
          if (delayMs) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          if (destroyed) {
            throw new Error("stream destroyed");
          }
          yield chunk;
        }
      },
    };
  }

  it("reads complete body", async () => {
    const stream = createMockStream([
      Buffer.from("hello"),
      Buffer.from(" world"),
    ]);
    const result = await readBody(stream);
    expect("ok" in result).toBe(true);
    if ("ok" in result) {
      expect(Buffer.from(result.body).toString()).toBe("hello world");
    }
  });

  it("returns empty error for empty body", async () => {
    const stream = createMockStream([]);
    const result = await readBody(stream);
    expect(result).toEqual({ error: "empty" });
  });

  it("returns too_large for oversized body", async () => {
    const big = Buffer.alloc(7_000_000);
    const stream = createMockStream([big]);
    const result = await readBody(stream);
    expect(result).toEqual({ error: "too_large" });
  });

  it("returns timeout for slow stream", async () => {
    // Each chunk takes 50ms, timeout is 30ms
    const stream = createMockStream([Buffer.from("a"), Buffer.from("b")], 50);
    const result = await readBody(stream, 30);
    expect(result).toEqual({ error: "timeout" });
  });

  it("succeeds when fast enough", async () => {
    // Each chunk takes 10ms, timeout is 200ms
    const stream = createMockStream([Buffer.from("a"), Buffer.from("b")], 10);
    const result = await readBody(stream, 200);
    expect("ok" in result).toBe(true);
  });
});
