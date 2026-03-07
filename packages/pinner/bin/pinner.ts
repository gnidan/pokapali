#!/usr/bin/env node

import { createServer } from "node:http";
import { createPinner } from "../src/index.js";
import { startRelay } from "../src/relay.js";

function parseArgs(argv: string[]): {
  port: number;
  storagePath: string;
  appIds: string[];
  announceAddrs: string[];
} {
  let port = 3000;
  let storagePath = "";
  let appIds: string[] = [];
  let announceAddrs: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    } else if (arg === "--storage-path" && argv[i + 1]) {
      storagePath = argv[++i];
    } else if (arg === "--app-ids" && argv[i + 1]) {
      appIds = argv[++i].split(",").map((s) => s.trim());
    } else if (arg === "--announce" && argv[i + 1]) {
      announceAddrs = argv[++i]
        .split(",")
        .map((s) => s.trim());
    }
  }

  if (!storagePath) {
    console.error("--storage-path is required");
    process.exit(1);
  }
  if (appIds.length === 0) {
    console.error("--app-ids is required");
    process.exit(1);
  }

  return { port, storagePath, appIds, announceAddrs };
}

async function main() {
  // libp2p/webrtc throws unhandled errors when data
  // channels close unexpectedly. Catch these so the
  // process doesn't crash.
  process.on("uncaughtException", (err) => {
    console.error("uncaught exception:", err.message);
  });

  const { port, storagePath, appIds, announceAddrs } =
    parseArgs(process.argv);

  const pinner = await createPinner({
    appIds,
    storagePath,
  });

  await pinner.start();
  console.error(`pinner started on port ${port}`);
  console.error(`  app-ids: ${appIds.join(", ")}`);
  console.error(`  storage: ${storagePath}`);

  // Start libp2p relay for GossipSub peer discovery
  // and circuit relay. Browsers find this node via
  // DHT and connect for signaling relay.
  const relay = await startRelay({
    appIds,
    storagePath,
    announceAddrs,
  });
  console.error("relay started");
  for (const ma of relay.multiaddrs()) {
    console.error(`  ${ma}`);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const ingestMatch = url.pathname.match(
      /^\/ingest\/([a-zA-Z0-9._-]+)$/
    );
    if (req.method === "POST" && ingestMatch) {
      const ipnsName = ingestMatch[1];
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
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
        console.error(`ingested block for ${ipnsName}`);
        res.writeHead(200, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        console.error(
          `rejected block for ${ipnsName}`
        );
        res.writeHead(429, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: "rejected" }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port);

  async function shutdown() {
    console.error("shutting down...");
    server.close();
    await relay.stop();
    await pinner.stop();
    console.error("stopped");
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
