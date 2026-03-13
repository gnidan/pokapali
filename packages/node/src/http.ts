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

// Request body read timeout (Slowloris protection).
// Aborts connections that trickle data too slowly.
const BODY_READ_TIMEOUT_MS = 30_000;

type ReadBodyResult =
  | { ok: true; body: Uint8Array }
  | { error: "too_large" | "timeout" | "empty" };

/** @internal Exported for testing. */
export async function readBody(
  req: AsyncIterable<Buffer> & { destroy(): void },
  timeoutMs: number = BODY_READ_TIMEOUT_MS,
): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    req.destroy();
  }, timeoutMs);

  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return { error: "too_large" };
      }
      chunks.push(buf);
    }
  } catch {
    // Stream destroyed — timeout or client abort
    if (timedOut) return { error: "timeout" };
    return { error: "timeout" };
  } finally {
    clearTimeout(timer);
  }

  const body = new Uint8Array(Buffer.concat(chunks));
  if (body.length === 0) return { error: "empty" };
  return { ok: true, body };
}

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
    const topics: Record<
      string,
      {
        subscribers: number;
        mesh: number;
      }
    > = {};
    for (const t of gsTopics) {
      const subs = pubsub.getSubscribers(t);
      const mp = pubsub.getMeshPeers?.(t);
      topics[t] = {
        subscribers: subs.length,
        mesh: mp?.length ?? 0,
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

function getGossipsubMetrics(
  config: HttpConfig,
): Record<string, unknown> | null {
  const { relay } = config;
  if (!relay) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gs = (relay.helia.libp2p.services as any).pubsub as any;
  if (!gs) return null;

  const gsTopics: string[] = gs.getTopics?.() ?? [];
  const gsPeers: { toString(): string }[] = gs.getPeers?.() ?? [];
  const backoffMap = gs.backoff as Map<string, Map<string, number>> | undefined;
  const streamsOut = gs.streamsOutbound as Map<string, unknown> | undefined;

  const now = Date.now();

  // Per-topic mesh, subscribers, backoff, and
  // per-peer detail
  const topics: Record<
    string,
    {
      subscribers: number;
      mesh: number;
      meshPeers: {
        peerId: string;
        score: number | null;
        hasStream: boolean;
        backoffSec: number | null;
      }[];
    }
  > = {};
  const meshPeerIds = new Set<string>();
  for (const t of gsTopics) {
    const subs = gs.getSubscribers?.(t) ?? [];
    const mp: { toString(): string }[] = gs.getMeshPeers?.(t) ?? [];
    const topicBackoff = backoffMap?.get(t);
    const meshPeers: {
      peerId: string;
      score: number | null;
      hasStream: boolean;
      backoffSec: number | null;
    }[] = [];
    for (const p of mp) {
      const pid = p.toString();
      meshPeerIds.add(pid);
      const score = gs.score?.score?.(pid);
      const boExpiry = topicBackoff?.get(pid);
      const boSec =
        typeof boExpiry === "number" && boExpiry > now
          ? Math.round((boExpiry - now) / 1000)
          : null;
      meshPeers.push({
        peerId: pid,
        score: typeof score === "number" ? Math.round(score * 100) / 100 : null,
        hasStream: streamsOut?.has(pid) ?? false,
        backoffSec: boSec,
      });
    }
    topics[t] = {
      subscribers: subs.length,
      mesh: mp.length,
      meshPeers,
    };
  }

  // Score distribution summary
  const scoreValues: number[] = [];
  for (const pid of meshPeerIds) {
    const score = gs.score?.score?.(pid);
    if (typeof score === "number") {
      scoreValues.push(Math.round(score * 100) / 100);
    }
  }
  const sorted = [...scoreValues].sort((a, b) => a - b);
  const distribution =
    sorted.length > 0
      ? {
          min: sorted[0],
          max: sorted[sorted.length - 1],
          median: sorted[Math.floor(sorted.length / 2)],
          negative: sorted.filter((s) => s < 0).length,
          count: sorted.length,
        }
      : null;

  // Relay peer connectivity — which known relay
  // peers are connected vs disconnected
  const connectedPids = new Set(
    relay.helia.libp2p
      .getConnections()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => c.remotePeer.toString()),
  );
  // knownRelayPeerIds is internal to relay.ts —
  // approximate from peers with score >= 100
  // (relay appSpecificScore) that are in mesh
  const relayPeers: {
    peerId: string;
    connected: boolean;
    score: number | null;
  }[] = [];
  for (const pid of meshPeerIds) {
    const score = gs.score?.score?.(pid);
    if (typeof score === "number" && score >= 90) {
      relayPeers.push({
        peerId: pid,
        connected: connectedPids.has(pid),
        score: Math.round(score * 100) / 100,
      });
    }
  }

  return {
    peers: gsPeers.length,
    topics,
    meshPeerCount: meshPeerIds.size,
    scoreDistribution: distribution,
    relayPeers,
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
        gossipsub: getGossipsubMetrics(config),
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
        const result = await readBody(req);
        if (!("ok" in result)) {
          if (result.error === "too_large") {
            res.writeHead(413, {
              "content-type": "application/json",
            });
            res.end(
              JSON.stringify({
                error: "body too large",
              }),
            );
          } else if (result.error === "timeout") {
            res.writeHead(408, {
              "content-type": "application/json",
            });
            res.end(
              JSON.stringify({
                error: "request timeout",
              }),
            );
          } else {
            res.writeHead(400, {
              "content-type": "application/json",
            });
            res.end(
              JSON.stringify({
                error: "empty body",
              }),
            );
          }
          return;
        }
        const body = result.body;

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

export type VersionTier = "tip" | "full" | "hourly" | "daily";

export interface RetentionPolicy {
  fullResolutionMs: number;
  hourlyRetentionMs: number;
  dailyRetentionMs: number;
}

export interface TipResponse {
  ipnsName: string;
  cid: string;
  block: Uint8Array;
  seq: number;
  ts: number;
  peerId: string;
  guaranteeUntil: number;
  retainUntil: number;
}

export interface GuaranteeResponse {
  ipnsName: string;
  cid: string;
  peerId: string;
  guaranteeUntil: number;
  retainUntil: number;
}

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
  /** History lookup — returns snapshot records for
   *  an IPNS name, filtered to blocks we still have. */
  getHistory?: (ipnsName: string) => Promise<{ cid: string; ts: number }[]>;
  /** Retention policy for tier classification. */
  retentionPolicy?: RetentionPolicy;
  /** Tip data lookup for GET /tip/:ipnsName. */
  getTipData?: (ipnsName: string) => Promise<TipResponse | null>;
  /** Guarantee lookup for GET /guarantee/:ipnsName. */
  getGuarantee?: (ipnsName: string) => GuaranteeResponse | null;
  /** Record browser activity on HTTP access. */
  recordActivity?: (ipnsName: string) => void;
}

function classifyTier(
  ts: number,
  isTip: boolean,
  now: number,
  policy: RetentionPolicy,
): { tier: VersionTier; expiresAt: number | null } {
  if (isTip) {
    return { tier: "tip", expiresAt: null };
  }
  const age = now - ts;
  if (age <= policy.fullResolutionMs) {
    return {
      tier: "full",
      expiresAt: ts + policy.fullResolutionMs,
    };
  }
  if (age <= policy.hourlyRetentionMs) {
    return {
      tier: "hourly",
      expiresAt: ts + policy.hourlyRetentionMs,
    };
  }
  return {
    tier: "daily",
    expiresAt: ts + policy.dailyRetentionMs,
  };
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

      // GET /tip/:ipnsName
      const tipMatch = url.pathname.match(/^\/tip\/([a-fA-F0-9]{64})$/);
      if (req.method === "GET" && tipMatch && config.getTipData) {
        const ipnsName = tipMatch[1];
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

        try {
          const tip = await config.getTipData(ipnsName);
          if (!tip) {
            res.writeHead(404, {
              "content-type": "application/json",
              ...cors,
            });
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }

          // Record activity as demand signal
          config.recordActivity?.(ipnsName);

          // Encode block as base64 for JSON transport
          const blockB64 = Buffer.from(tip.block).toString("base64");
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-cache",
            ...cors,
          });
          res.end(
            JSON.stringify({
              ipnsName: tip.ipnsName,
              cid: tip.cid,
              block: blockB64,
              seq: tip.seq,
              ts: tip.ts,
              peerId: tip.peerId,
              guaranteeUntil: tip.guaranteeUntil,
              retainUntil: tip.retainUntil,
            }),
          );
        } catch (err) {
          log.warn("tip error:", (err as Error).message);
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

      // GET /guarantee/:ipnsName
      const guarMatch = url.pathname.match(/^\/guarantee\/([a-fA-F0-9]{64})$/);
      if (req.method === "GET" && guarMatch && config.getGuarantee) {
        const ipnsName = guarMatch[1];
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

        const data = config.getGuarantee(ipnsName);
        if (!data) {
          res.writeHead(404, {
            "content-type": "application/json",
            ...cors,
          });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }

        // Record activity as demand signal
        config.recordActivity?.(ipnsName);

        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-cache",
          ...cors,
        });
        res.end(JSON.stringify(data));
        return;
      }

      // GET /history/:ipnsName
      const histMatch = url.pathname.match(/^\/history\/([a-fA-F0-9]+)$/);
      if (req.method === "GET" && histMatch && config.getHistory) {
        const ipnsName = histMatch[1];
        const limit = Math.min(
          parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
          200,
        );
        const before = parseInt(url.searchParams.get("before") ?? "", 10);

        try {
          const records = await config.getHistory(ipnsName);

          // Sort newest-first, assign seq numbers
          records.sort((a, b) => b.ts - a.ts);
          const now = Date.now();
          const policy = config.retentionPolicy;
          const tipCid = records.length > 0 ? records[0].cid : null;

          const withSeq = records.map((r, i) => {
            const base = {
              cid: r.cid,
              ts: r.ts,
              seq: records.length - i,
            };
            if (!policy) return base;
            const { tier, expiresAt } = classifyTier(
              r.ts,
              r.cid === tipCid,
              now,
              policy,
            );
            return { ...base, tier, expiresAt };
          });

          // Paginate: before=seq filters to
          // entries with seq < before
          let page = withSeq;
          if (!Number.isNaN(before) && before > 0) {
            page = page.filter((r) => r.seq < before);
          }
          page = page.slice(0, limit);

          const body: Record<string, unknown> = {
            versions: page,
            totalVersions: records.length,
            oldestSeq: records.length > 0 ? 1 : null,
          };
          if (policy) {
            body.retentionPolicy = policy;
          }

          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-cache",
            ...cors,
          });
          res.end(JSON.stringify(body));
        } catch (err) {
          log.warn("history error:", (err as Error).message);
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

      // /block/:cid (GET or POST)
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
        const result = await readBody(req);
        if (!("ok" in result)) {
          if (result.error === "too_large") {
            res.writeHead(413, {
              "content-type": "application/json",
              ...cors,
            });
            res.end(
              JSON.stringify({
                error: "body too large",
              }),
            );
          } else if (result.error === "timeout") {
            res.writeHead(408, {
              "content-type": "application/json",
              ...cors,
            });
            res.end(
              JSON.stringify({
                error: "request timeout",
              }),
            );
          } else {
            res.writeHead(400, {
              "content-type": "application/json",
              ...cors,
            });
            res.end(
              JSON.stringify({
                error: "empty body",
              }),
            );
          }
          return;
        }
        const body = result.body;

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
