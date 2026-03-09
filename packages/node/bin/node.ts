#!/usr/bin/env node

import { createPinner } from "../src/index.js";
import { startRelay } from "../src/relay.js";
import { startHttpServer } from "../src/http.js";
import {
  announceTopic,
  parseAnnouncement,
} from "@pokapali/core/announce";
import {
  createLogger,
  setLogLevel,
} from "@pokapali/log";
import type { LogLevel } from "@pokapali/log";

const log = createLogger("node");

const VALID_LOG_LEVELS: LogLevel[] = [
  "debug", "info", "warn", "error",
];

function parseArgs(argv: string[]): {
  port: number;
  storagePath: string;
  relay: boolean;
  pinApps: string[];
  announceAddrs: string[];
  logLevel: LogLevel | null;
} {
  let port = 3000;
  let storagePath = "";
  let relay = false;
  let pinApps: string[] = [];
  let announceAddrs: string[] = [];
  let logLevel: LogLevel | null = null;

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
    } else if (
      arg === "--log-level" && argv[i + 1]
    ) {
      const val = argv[++i];
      if (
        !VALID_LOG_LEVELS.includes(val as LogLevel)
      ) {
        console.error(
          `invalid --log-level "${val}".`
          + ` Valid: ${VALID_LOG_LEVELS.join(", ")}`,
        );
        process.exit(1);
      }
      logLevel = val as LogLevel;
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
    port, storagePath, relay, pinApps,
    announceAddrs, logLevel,
  };
}

async function main() {
  // libp2p/webrtc throws unhandled errors when data
  // channels close unexpectedly. Catch these so the
  // process doesn't crash.
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception:", err.message);
  });

  const {
    port, storagePath, relay, pinApps,
    announceAddrs, logLevel,
  } = parseArgs(process.argv);

  // CLI --log-level overrides POKAPALI_LOG_LEVEL env
  if (logLevel) {
    setLogLevel(logLevel);
  }

  const modes = [
    relay ? "relay" : "",
    pinApps.length > 0 ? "pin" : "",
  ].filter(Boolean).join("+");
  log.info(`starting (${modes})`);
  log.info(`  storage: ${storagePath}`);

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
    log.info("relay started");
    for (const ma of relayHandle.multiaddrs()) {
      log.info(`  ${ma}`);
    }
  }

  if (pinApps.length > 0) {
    pinner = await createPinner({
      appIds: pinApps,
      storagePath,
      helia: relayHandle?.helia,
    });
    await pinner.start();
    log.info(
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
          const msg = parseAnnouncement(
            evt.detail.data,
          );
          if (msg) {
            pinner!.onAnnouncement(
              msg.ipnsName,
              msg.cid,
            );
          }
        },
      );
      log.info(
        "wired GossipSub announcements to pinner",
      );
    }
  }

  // Always start HTTP server for health/status
  // endpoints (and pinner ingest if applicable).
  const server = startHttpServer({
    port,
    relay: relayHandle,
    pinner,
    pinAppIds: pinApps,
  });
  log.info(`HTTP server on port ${port}`);

  async function shutdown() {
    log.info("shutting down...");
    server.close();
    if (relayHandle) await relayHandle.stop();
    if (pinner) await pinner.stop();
    log.info("stopped");
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
