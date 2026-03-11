#!/usr/bin/env node

import { createPinner } from "../src/index.js";
import { startRelay, deriveHttpUrl } from "../src/relay.js";
import { startHttpServer, startBlockServer } from "../src/http.js";
import {
  announceTopic,
  parseAnnouncement,
  base64ToUint8,
} from "@pokapali/core/announce";
import { createLogger, setLogLevel } from "@pokapali/log";
import type { LogLevel } from "@pokapali/log";
import type { Server as HttpsServer } from "node:https";

const log = createLogger("node");

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function printHelp(): void {
  console.log(`\
Usage: pokapali-node [options]

Options:
  --storage-path <path>       Storage directory (required)
  --relay                     Run as relay node
  --pin <app1,app2,...>       Pin snapshots for app IDs
  --port <number>             HTTP admin port (default: 3000)
  --https-port <number>       HTTPS block server port (default: 4443)
  --cors-origin <origins>     CORS origins (default: "*")
  --rate-limit-rpm <number>   Block requests/min per IP (default: 60)
  --trust-proxy               Trust X-Forwarded-For for rate limiting
  --announce <addr1,addr2>    Public multiaddrs to announce
  --delegated-routing <url>   Delegated routing endpoint
                              (default: delegated-ipfs.dev)
  --log-level <level>         debug, info, warn, error
  --help                      Show this help message

At least one of --relay or --pin is required.`);
}

interface ParsedArgs {
  port: number;
  httpsPort: number;
  corsOrigin: string;
  rateLimitRpm: number;
  trustProxy: boolean;
  storagePath: string;
  relay: boolean;
  pinApps: string[];
  announceAddrs: string[];
  delegatedRoutingUrl: string | null;
  logLevel: LogLevel | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let port = 3000;
  let httpsPort = 4443;
  let corsOrigin = "*";
  let rateLimitRpm = 60;
  let trustProxy = false;
  let storagePath = "";
  let relay = false;
  let pinApps: string[] = [];
  let announceAddrs: string[] = [];
  let delegatedRoutingUrl: string | null = null;
  let logLevel: LogLevel | null = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
      if (Number.isNaN(port)) {
        console.error(`invalid --port value: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--https-port" && argv[i + 1]) {
      httpsPort = parseInt(argv[++i], 10);
      if (Number.isNaN(httpsPort)) {
        console.error(`invalid --https-port value: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--cors-origin" && argv[i + 1]) {
      corsOrigin = argv[++i];
    } else if (arg === "--rate-limit-rpm" && argv[i + 1]) {
      rateLimitRpm = parseInt(argv[++i], 10);
      if (Number.isNaN(rateLimitRpm)) {
        console.error(`invalid --rate-limit-rpm: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--trust-proxy") {
      trustProxy = true;
    } else if (arg === "--storage-path" && argv[i + 1]) {
      storagePath = argv[++i];
    } else if (arg === "--relay") {
      relay = true;
    } else if (arg === "--pin" && argv[i + 1]) {
      pinApps = argv[++i].split(",").map((s) => s.trim());
    } else if (arg === "--announce" && argv[i + 1]) {
      announceAddrs = argv[++i].split(",").map((s) => s.trim());
    } else if (arg === "--delegated-routing" && argv[i + 1]) {
      delegatedRoutingUrl = argv[++i];
    } else if (arg === "--log-level" && argv[i + 1]) {
      const val = argv[++i];
      if (!VALID_LOG_LEVELS.includes(val as LogLevel)) {
        console.error(
          `invalid --log-level "${val}".` +
            ` Valid: ${VALID_LOG_LEVELS.join(", ")}`,
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
    console.error("at least one of --relay or --pin" + " is required");
    process.exit(1);
  }

  return {
    port,
    httpsPort,
    corsOrigin,
    rateLimitRpm,
    trustProxy,
    storagePath,
    relay,
    pinApps,
    announceAddrs,
    delegatedRoutingUrl,
    logLevel,
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
    port,
    httpsPort,
    corsOrigin,
    rateLimitRpm,
    trustProxy,
    storagePath,
    relay,
    pinApps,
    announceAddrs,
    delegatedRoutingUrl,
    logLevel,
  } = parseArgs(process.argv);

  // CLI --log-level overrides POKAPALI_LOG_LEVEL env
  if (logLevel) {
    setLogLevel(logLevel);
  }

  const modes = [relay ? "relay" : "", pinApps.length > 0 ? "pin" : ""]
    .filter(Boolean)
    .join("+");
  log.info(`starting (${modes})`);
  log.info(`  storage: ${storagePath}`);

  let relayHandle: Awaited<ReturnType<typeof startRelay>> | null = null;
  let pinner: Awaited<ReturnType<typeof createPinner>> | null = null;

  if (relay) {
    relayHandle = await startRelay({
      storagePath,
      announceAddrs,
      pinAppIds: pinApps.length > 0 ? pinApps : undefined,
      delegatedRoutingUrl: delegatedRoutingUrl ?? undefined,
    });
    log.info("relay started");
    for (const ma of relayHandle.multiaddrs()) {
      log.info(`  ${ma}`);
    }
  }

  // Start HTTPS block server when cert arrives
  let blockServer: HttpsServer | null = null;
  if (relayHandle) {
    // Check if cert is already available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const autoTLSSvc = (relayHandle.helia.libp2p.services as any).autoTLS;
    const existingCert = autoTLSSvc?.certificate;

    const launchBlockServer = (cert: { key: string; cert: string }) => {
      if (blockServer) return; // already started
      const blockstore = relayHandle!.helia.blockstore;
      blockServer = startBlockServer({
        port: httpsPort,
        key: cert.key,
        cert: cert.cert,
        corsOrigin,
        rateLimitRpm,
        trustProxy,
        getBlock: async (cid) => {
          try {
            const has = await blockstore.has(cid);
            if (!has) return null;
            return await blockstore.get(cid);
          } catch {
            return null;
          }
        },
      });

      // Derive httpUrl from WSS multiaddr
      const wssAddr = relayHandle!
        .multiaddrs()
        .find((a) => a.includes("/tls/"));
      if (wssAddr) {
        const url = deriveHttpUrl(wssAddr, httpsPort);
        if (url) {
          relayHandle!.httpUrl = url;
          log.info(`block endpoint: ${url}`);
        }
      }
    };

    if (existingCert?.key && existingCert?.cert) {
      launchBlockServer(existingCert);
    }

    relayHandle.helia.libp2p.addEventListener(
      "certificate:provision",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (evt: any) => {
        const cert = evt.detail;
        if (cert?.key && cert?.cert) {
          launchBlockServer(cert);
        }
      },
    );

    // Handle cert renewal — swap server
    relayHandle.helia.libp2p.addEventListener(
      "certificate:renew",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (evt: any) => {
        const cert = evt.detail;
        if (!cert?.key || !cert?.cert) return;
        log.info("cert renewed, restarting block server");
        const old = blockServer;
        blockServer = null;
        if (old) {
          old.close();
          old.closeAllConnections();
        }
        launchBlockServer(cert);
      },
    );
  }

  // Extract pubsub from relay for pinner ack support
  const pubsub = relayHandle
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (relayHandle.helia.libp2p.services as any).pubsub
    : undefined;
  const peerId = relayHandle
    ? relayHandle.helia.libp2p.peerId.toString()
    : undefined;

  if (pinApps.length > 0) {
    pinner = await createPinner({
      appIds: pinApps,
      storagePath,
      helia: relayHandle?.helia,
      pubsub,
      peerId,
    });
    await pinner.start();
    log.info(`pinner started for: ${pinApps.join(", ")}`);

    // Wire GossipSub announcements to pinner
    if (relayHandle) {
      const topicToApp = new Map<string, string>();
      for (const app of pinApps) {
        topicToApp.set(announceTopic(app), app);
      }
      pubsub.addEventListener(
        "message",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (evt: any) => {
          const appId = topicToApp.get(evt.detail.topic);
          if (!appId) return;
          const msg = parseAnnouncement(evt.detail.data);
          if (msg && !msg.ack) {
            const blockData = msg.block ? base64ToUint8(msg.block) : undefined;
            pinner!.onAnnouncement(
              msg.ipnsName,
              msg.cid,
              appId,
              blockData,
              msg.fromPinner,
            );
            return;
          }

          // Check for guarantee query
          try {
            const text = new TextDecoder().decode(evt.detail.data);
            const obj = JSON.parse(text);
            if (
              obj?.type === "guarantee-query" &&
              typeof obj.ipnsName === "string"
            ) {
              pinner!.onGuaranteeQuery(obj.ipnsName, appId);
            }
          } catch {
            // Not valid JSON — ignore
          }
        },
      );
      log.info("wired GossipSub announcements to pinner");
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
    server.closeAllConnections();
    if (blockServer) {
      blockServer.close();
      blockServer.closeAllConnections();
    }
    if (pinner) {
      await pinner.flush();
      await pinner.stop();
    }
    if (relayHandle) await relayHandle.stop();
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
