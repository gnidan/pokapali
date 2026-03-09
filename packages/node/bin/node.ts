#!/usr/bin/env node

import { createServer } from "node:http";
import { createPinner } from "../src/index.js";
import {
  startRelay,
  announceTopic,
} from "../src/relay.js";

function parseArgs(argv: string[]): {
  port: number;
  storagePath: string;
  relay: boolean;
  pinApps: string[];
  announceAddrs: string[];
} {
  let port = 3000;
  let storagePath = "";
  let relay = false;
  let pinApps: string[] = [];
  let announceAddrs: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    } else if (
      arg === "--storage-path" && argv[i + 1]
    ) {
      storagePath = argv[++i];
    } else if (arg === "--relay") {
      relay = true;
    } else if (arg === "--pin" && argv[i + 1]) {
      pinApps = argv[++i]
        .split(",")
        .map((s) => s.trim());
    } else if (
      arg === "--announce" && argv[i + 1]
    ) {
      announceAddrs = argv[++i]
        .split(",")
        .map((s) => s.trim());
    }
  }

  if (!storagePath) {
    console.error("--storage-path is required");
    process.exit(1);
  }
  if (!relay && pinApps.length === 0) {
    console.error(
      "at least one of --relay or --pin is required",
    );
    process.exit(1);
  }

  return {
    port, storagePath, relay, pinApps, announceAddrs,
  };
}

async function main() {
  // libp2p/webrtc throws unhandled errors when data
  // channels close unexpectedly. Catch these so the
  // process doesn't crash.
  process.on("uncaughtException", (err) => {
    console.error("uncaught exception:", err.message);
  });

  const {
    port, storagePath, relay, pinApps, announceAddrs,
  } = parseArgs(process.argv);

  const modes = [
    relay ? "relay" : "",
    pinApps.length > 0 ? "pin" : "",
  ].filter(Boolean).join("+");
  console.error(`pokapali node starting (${modes})`);
  console.error(`  storage: ${storagePath}`);

  let relayHandle: Awaited<
    ReturnType<typeof startRelay>
  > | null = null;
  let pinner: Awaited<
    ReturnType<typeof createPinner>
  > | null = null;

  if (relay) {
    relayHandle = await startRelay({
      storagePath,
      announceAddrs,
      pinAppIds: pinApps.length > 0
        ? pinApps
        : undefined,
    });
    console.error("relay started");
    for (const ma of relayHandle.multiaddrs()) {
      console.error(`  ${ma}`);
    }
  }

  if (pinApps.length > 0) {
    pinner = await createPinner({
      appIds: pinApps,
      storagePath,
    });
    await pinner.start();
    console.error(
      `pinner started for: ${pinApps.join(", ")}`,
    );

    // Wire GossipSub announcements to pinner
    if (relayHandle) {
      const announceTopics = new Set(
        pinApps.map(announceTopic),
      );
      const pubsub = (
        relayHandle.helia.libp2p.services as any
      ).pubsub;
      pubsub.addEventListener(
        "message",
        (evt: any) => {
          if (!announceTopics.has(evt.detail.topic)) {
            return;
          }
          try {
            const text = new TextDecoder().decode(
              evt.detail.data,
            );
            const msg = JSON.parse(text);
            if (
              typeof msg.ipnsName === "string" &&
              typeof msg.cid === "string"
            ) {
              pinner!.onAnnouncement(
                msg.ipnsName,
                msg.cid,
              );
            }
          } catch {
            // Ignore malformed messages
          }
        },
      );
      console.error(
        "wired GossipSub announcements to pinner",
      );
    }

    const server = createServer(async (req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://localhost:${port}`,
      );

      if (
        req.method === "GET" &&
        url.pathname === "/health"
      ) {
        res.writeHead(200, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const ingestMatch = url.pathname.match(
        /^\/ingest\/([a-zA-Z0-9._-]+)$/,
      );
      if (req.method === "POST" && ingestMatch) {
        const ipnsName = ingestMatch[1];
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = new Uint8Array(
          Buffer.concat(chunks),
        );

        if (body.length === 0) {
          res.writeHead(400, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({ error: "empty body" }),
          );
          return;
        }

        const accepted = await pinner!.ingest(
          ipnsName, body,
        );
        if (accepted) {
          console.error(
            `ingested block for ${ipnsName}`,
          );
          res.writeHead(200, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          console.error(
            `rejected block for ${ipnsName}`,
          );
          res.writeHead(429, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({ error: "rejected" }),
          );
        }
        return;
      }

      res.writeHead(404, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({ error: "not found" }),
      );
    });

    server.listen(port);
    console.error(`HTTP server on port ${port}`);
  }

  async function shutdown() {
    console.error("shutting down...");
    if (relayHandle) await relayHandle.stop();
    if (pinner) await pinner.stop();
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
