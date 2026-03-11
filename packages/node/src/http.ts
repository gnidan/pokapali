import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Relay } from "./relay.js";
import type { Pinner } from "./pinner.js";
import { createLogger, getLogLevel } from "@pokapali/log";

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
    const pubsub = (relay.helia.libp2p.services as any).pubsub;
    const gsTopics: string[] = pubsub.getTopics?.() ?? [];
    const gsPeers = pubsub.getPeers?.() ?? [];
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
