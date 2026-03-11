import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { execSync } from "node:child_process";
import { startHttpServer, startBlockServer } from "./http.js";
import type { HttpConfig, HttpsConfig } from "./http.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// Minimal mock relay that satisfies the interface
// used by getHealthData / getStatusData.
function mockRelay(opts?: {
  peerId?: string;
  connections?: number;
  peers?: number;
  multiaddrs?: string[];
  topics?: string[];
  gsPeers?: number;
}) {
  const pid = opts?.peerId ?? "12D3KooWTestPeer";
  const conns = Array.from({ length: opts?.connections ?? 2 }, () => ({}));
  const peers = Array.from({ length: opts?.peers ?? 3 }, () => ({}));
  const addrs = (opts?.multiaddrs ?? []).map((a) => ({ toString: () => a }));
  const topics = opts?.topics ?? [];
  const gsPeers = Array.from({ length: opts?.gsPeers ?? 0 }, () => ({}));

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
            getSubscribers: () => [],
            mesh: new Map(),
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
          topics: ["topic-a"],
          gsPeers: 2,
        }),
      });
      const res = await fetch(port, "GET", "/status");
      const data = JSON.parse(res.body);
      expect(data.gossipsub).not.toBeNull();
      expect(data.gossipsub.peers).toBe(2);
      expect(data.gossipsub.topics).toHaveProperty("topic-a");
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

// Generate self-signed cert for testing
let testKey: string;
let testCert: string;

beforeAll(() => {
  const out = execSync(
    "openssl req -x509 -newkey ec -pkeyopt" +
      " ec_paramgen_curve:prime256v1 -keyout /dev/stdout" +
      " -out /dev/stdout -days 1 -nodes" +
      ' -subj "/CN=localhost" 2>/dev/null',
    { encoding: "utf-8" },
  );
  // openssl outputs key then cert, both PEM
  const keyMatch = out.match(
    /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/,
  );
  const certMatch = out.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  );
  testKey = keyMatch![0];
  testCert = certMatch![0];
});

function fetchHttps(
  port: number,
  method: string,
  path: string,
  headers?: Record<string, string>,
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
        headers,
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
    expect(res.headers["access-control-allow-methods"]).toBe("GET");
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
});
