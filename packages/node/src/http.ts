import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Relay } from "./relay.js";
import type { Pinner } from "./pinner.js";
import { createLogger, getLogLevel } from "@pokapali/log";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createIpRateLimiter, type IpRateLimiter } from "./rate-limiter.js";

const startedAt = Date.now();
const log = createLogger("http");

// Hard cap on request body size to prevent memory
// exhaustion before the pinner's rate limiter runs.
// Slightly above the default maxBlockSizeBytes (5 MB)
// to account for encoding overhead.
const MAX_BODY_BYTES = 6_000_000;

export interface HttpConfig {
  port: number;
  relay: Relay | null;
  pinner: Pinner | null;
  pinAppIds: string[];
}

function getHealthData(config: HttpConfig) {
  const { relay } = config;
  const conns = relay ? relay.helia.libp2p.getConnections().length : 0;
  const peers = relay ? relay.helia.libp2p.getPeers().length : 0;

  return {
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    peerId: relay?.peerId() ?? null,
    peers,
    connections: conns,
  };
}

function getStatusData(config: HttpConfig) {
  const { relay, pinner, pinAppIds } = config;
  const health = getHealthData(config);

  const mode =
    [relay ? "relay" : "", pinner ? "pin" : ""].filter(Boolean).join("+") ||
    "none";

  const multiaddrs = relay?.multiaddrs() ?? [];
  const wss = multiaddrs.some((a) => a.includes("/tls/"));

  // GossipSub diagnostics
  let gossipsub: Record<string, unknown> | null = null;
  if (relay) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pubsub = (relay.helia.libp2p.services as any).pubsub;
    const gsTopics: string[] = pubsub.getTopics?.() ?? [];
    const gsPeers = pubsub.getPeers?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mesh = (pubsub as any).mesh as Map<string, Set<string>> | undefined;

    const topics: Record<
      string,
      {
        subscribers: number;
        mesh: number;
      }
    > = {};
    for (const t of gsTopics) {
      const subs = pubsub.getSubscribers(t);
      const topicMesh = mesh?.get(t);
      topics[t] = {
        subscribers: subs.length,
        mesh: topicMesh?.size ?? 0,
      };
    }

    gossipsub = {
      peers: gsPeers.length,
      topics,
    };
  }

  return {
    ...health,
    mode,
    multiaddrs,
    wss,
    gossipsub,
    pinApps: pinAppIds,
    logLevel: getLogLevel(),
  };
}

export function startHttpServer(config: HttpConfig): Server {
  const { pinner, port } = config;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const data = getHealthData(config);
      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const data = getStatusData(config);
      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      const mem = process.memoryUsage();
      const data: Record<string, unknown> = {
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        pinner: config.pinner ? config.pinner.metrics() : null,
      };
      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(data));
      return;
    }

    if (pinner) {
      const ingestMatch = url.pathname.match(/^\/ingest\/([a-zA-Z0-9._-]+)$/);
      if (req.method === "POST" && ingestMatch) {
        const ipnsName = ingestMatch[1];
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        for await (const chunk of req) {
          const buf = chunk as Buffer;
          size += buf.length;
          if (size > MAX_BODY_BYTES) {
            aborted = true;
            req.destroy();
            break;
          }
          chunks.push(buf);
        }
        if (aborted) {
          res.writeHead(413, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({
              error: "body too large",
            }),
          );
          return;
        }
        const body = new Uint8Array(Buffer.concat(chunks));

        if (body.length === 0) {
          res.writeHead(400, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ error: "empty body" }));
          return;
        }

        const accepted = await pinner.ingest(ipnsName, body);
        if (accepted) {
          log.debug(`ingested block for ${ipnsName}`);
          res.writeHead(200, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          log.warn(`rejected block for ${ipnsName}`);
          res.writeHead(429, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ error: "rejected" }));
        }
        return;
      }
    }

    res.writeHead(404, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port);
  return server;
}

// --- HTTPS block server ---

export interface HttpsConfig {
  port: number;
  key: string;
  cert: string;
  corsOrigin: string;
  rateLimitRpm: number;
  trustProxy: boolean;
  /** Blockstore get function — serves raw bytes. */
  getBlock: (cid: CID) => Promise<Uint8Array | null>;
  /** Blockstore put function — stores raw bytes. */
  putBlock: (cid: CID, bytes: Uint8Array) => Promise<void>;
}

function parseCorsOrigins(origin: string): string[] | "*" {
  if (origin === "*") return "*";
  return origin
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(
  requestOrigin: string | undefined,
  configured: string[] | "*",
): Record<string, string> {
  if (configured === "*") {
    return { "access-control-allow-origin": "*" };
  }
  if (requestOrigin && configured.includes(requestOrigin)) {
    return {
      "access-control-allow-origin": requestOrigin,
      vary: "Origin",
    };
  }
  return {};
}

function getClientIp(
  req: {
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
  },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function startBlockServer(config: HttpsConfig): HttpsServer {
  const origins = parseCorsOrigins(config.corsOrigin);
  const limiter: IpRateLimiter = createIpRateLimiter(config.rateLimitRpm);

  const server = createHttpsServer(
    { key: config.key, cert: config.cert },
    async (req, res) => {
      const url = new URL(req.url ?? "/", `https://localhost:${config.port}`);
      const reqOrigin = req.headers.origin;
      const cors = corsHeaders(reqOrigin, origins);

      // OPTIONS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...cors,
          "access-control-allow-methods": "GET, POST",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }

      // Only /block/:cid
      const match = url.pathname.match(/^\/block\/(.+)$/);
      if (!match || (req.method !== "GET" && req.method !== "POST")) {
        res.writeHead(404, {
          "content-type": "application/json",
          ...cors,
        });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      // Rate limit
      const ip = getClientIp(req, config.trustProxy);
      if (!limiter.check(ip)) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "60",
          ...cors,
        });
        res.end(
          JSON.stringify({
            error: "too many requests",
          }),
        );
        return;
      }
      limiter.record(ip);

      // Parse CID
      let cid: CID;
      try {
        cid = CID.parse(match[1]);
      } catch {
        res.writeHead(400, {
          "content-type": "application/json",
          ...cors,
        });
        res.end(JSON.stringify({ error: "invalid CID" }));
        return;
      }

      // --- POST /block/:cid ---
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        for await (const chunk of req) {
          const buf = chunk as Buffer;
          size += buf.length;
          if (size > MAX_BODY_BYTES) {
            aborted = true;
            req.destroy();
            break;
          }
          chunks.push(buf);
        }
        if (aborted) {
          res.writeHead(413, {
            "content-type": "application/json",
            ...cors,
          });
          res.end(
            JSON.stringify({
              error: "body too large",
            }),
          );
          return;
        }
        const body = new Uint8Array(Buffer.concat(chunks));
        if (body.length === 0) {
          res.writeHead(400, {
            "content-type": "application/json",
            ...cors,
          });
          res.end(JSON.stringify({ error: "empty body" }));
          return;
        }

        // Verify CID matches body content
        try {
          const hash = await sha256.digest(body);
          const computed = CID.createV1(cid.code, hash);
          if (!computed.equals(cid)) {
            res.writeHead(400, {
              "content-type": "application/json",
              ...cors,
            });
            res.end(
              JSON.stringify({
                error: "CID mismatch",
              }),
            );
            return;
          }
        } catch {
          res.writeHead(400, {
            "content-type": "application/json",
            ...cors,
          });
          res.end(
            JSON.stringify({
              error: "CID verification failed",
            }),
          );
          return;
        }

        // Store block
        try {
          await config.putBlock(cid, body);
          log.debug(`stored block ${cid.toString().slice(0, 16)}...`);
          res.writeHead(200, {
            "content-type": "application/json",
            ...cors,
          });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          log.warn("block put error:", (err as Error).message);
          res.writeHead(500, {
            "content-type": "application/json",
            ...cors,
          });
          res.end(
            JSON.stringify({
              error: "internal error",
            }),
          );
        }
        return;
      }

      // --- GET /block/:cid ---
      try {
        const block = await config.getBlock(cid);
        if (!block) {
          res.writeHead(404, {
            "content-type": "application/json",
            ...cors,
          });
          res.end(
            JSON.stringify({
              error: "block not found",
            }),
          );
          return;
        }

        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(block.length),
          "cache-control": "public, max-age=31536000, immutable",
          ...cors,
        });
        res.end(block);
      } catch (err) {
        log.warn("block fetch error:", (err as Error).message);
        res.writeHead(500, {
          "content-type": "application/json",
          ...cors,
        });
        res.end(
          JSON.stringify({
            error: "internal error",
          }),
        );
      }
    },
  );

  server.listen(config.port);
  log.info(`HTTPS block server on port ${config.port}`);
  return server;
}
