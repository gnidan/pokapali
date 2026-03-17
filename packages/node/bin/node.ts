#!/usr/bin/env node

import { createPinner } from "../src/index.js";
import {
  startRelay,
  deriveHttpUrl,
  deriveHttpUrlFromCert,
} from "../src/relay.js";
import { startHttpServer, startBlockServer } from "../src/http.js";
import {
  announceTopic,
  parseAnnouncement,
  base64ToUint8,
} from "@pokapali/core/announce";
import { CID } from "multiformats/cid";
import { createLogger, setLogLevel } from "@pokapali/log";
import type { LogLevel } from "@pokapali/log";
import type { Server as HttpsServer } from "node:https";

const log = createLogger("node");

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function printHelp(): void {
  log.info(`\
Usage: pokapali-node [options]

Options:
  --storage-path <path>       Storage directory (required)
  --relay                     Run as relay node (generic,
                              auto-forwards for any app)
  --pin <app1,app2,...>       Pin snapshots for app IDs
  --port <number>             HTTP admin port (default: 3000)
  --https-port <number>       HTTPS block server port (default: 4443)
  --cors-origin <origins>     CORS origins (default: "*")
  --rate-limit-rpm <number>   Block requests/min per IP (default: 60)
  --trust-proxy               Trust X-Forwarded-For for rate limiting
  --announce <addr1,addr2>    Public multiaddrs to announce
  --delegated-routing <url>   Delegated routing endpoint
                              (default: delegated-ipfs.dev)
  --retention-full <ms>       Full-resolution retention
                              (default: 7d = 604800000)
  --retention-hourly <ms>     Hourly retention
                              (default: 14d = 1209600000)
  --retention-daily <ms>      Daily retention
                              (default: 30d = 2592000000)
  --ipns-rate-limit <n>       Max IPNS requests/sec to
                              delegated routing (default: 10)
  --stale-resolve-days <n>    Drop names with no activity
                              and no resolve for N days
                              (default: 3, 0 = disable)
  --tcp-port <number>         libp2p TCP port (default: 4001)
  --ws-port <number>          libp2p WebSocket port
                              (default: 4003)
  --no-tls                     Skip autoTLS cert provisioning
  --log-level <level>         debug, info, warn, error
  --help                      Show this help message

At least one of --relay or --pin is required.`);
}

const MS_PER_DAY = 24 * 60 * 60_000;
const DEFAULT_RETENTION_FULL_MS = 7 * MS_PER_DAY;
const DEFAULT_RETENTION_HOURLY_MS = 14 * MS_PER_DAY;
const DEFAULT_RETENTION_DAILY_MS = 30 * MS_PER_DAY;

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
  retentionFullMs: number;
  retentionHourlyMs: number;
  retentionDailyMs: number;
  ipnsRateLimit: number;
  staleResolveDays: number;
  noTls: boolean;
  tcpPort: number | undefined;
  wsPort: number | undefined;
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
  let retentionFullMs = DEFAULT_RETENTION_FULL_MS;
  let retentionHourlyMs = DEFAULT_RETENTION_HOURLY_MS;
  let retentionDailyMs = DEFAULT_RETENTION_DAILY_MS;
  let ipnsRateLimit = 10;
  let staleResolveDays = 3;
  let noTls = false;
  let tcpPort: number | undefined = undefined;
  let wsPort: number | undefined = undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
      if (Number.isNaN(port)) {
        log.error(`invalid --port value: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--https-port" && argv[i + 1]) {
      httpsPort = parseInt(argv[++i], 10);
      if (Number.isNaN(httpsPort)) {
        log.error(`invalid --https-port value: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--cors-origin" && argv[i + 1]) {
      corsOrigin = argv[++i];
    } else if (arg === "--rate-limit-rpm" && argv[i + 1]) {
      rateLimitRpm = parseInt(argv[++i], 10);
      if (Number.isNaN(rateLimitRpm)) {
        log.error(`invalid --rate-limit-rpm: "${argv[i]}"`);
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
        log.error(
          `invalid --log-level "${val}".` +
            ` Valid: ${VALID_LOG_LEVELS.join(", ")}`,
        );
        process.exit(1);
      }
      logLevel = val as LogLevel;
    } else if (arg === "--retention-full" && argv[i + 1]) {
      retentionFullMs = parseInt(argv[++i], 10);
      if (Number.isNaN(retentionFullMs)) {
        log.error(`invalid --retention-full: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--retention-hourly" && argv[i + 1]) {
      retentionHourlyMs = parseInt(argv[++i], 10);
      if (Number.isNaN(retentionHourlyMs)) {
        log.error(`invalid --retention-hourly: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--retention-daily" && argv[i + 1]) {
      retentionDailyMs = parseInt(argv[++i], 10);
      if (Number.isNaN(retentionDailyMs)) {
        log.error(`invalid --retention-daily: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--ipns-rate-limit" && argv[i + 1]) {
      ipnsRateLimit = parseInt(argv[++i], 10);
      if (Number.isNaN(ipnsRateLimit) || ipnsRateLimit < 1) {
        log.error(`invalid --ipns-rate-limit: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--stale-resolve-days" && argv[i + 1]) {
      staleResolveDays = parseInt(argv[++i], 10);
      if (Number.isNaN(staleResolveDays) || staleResolveDays < 0) {
        log.error(`invalid --stale-resolve-days:` + ` "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--tcp-port" && argv[i + 1]) {
      tcpPort = parseInt(argv[++i], 10);
      if (Number.isNaN(tcpPort)) {
        log.error(`invalid --tcp-port value: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--ws-port" && argv[i + 1]) {
      wsPort = parseInt(argv[++i], 10);
      if (Number.isNaN(wsPort)) {
        log.error(`invalid --ws-port value: "${argv[i]}"`);
        process.exit(1);
      }
    } else if (arg === "--no-tls") {
      noTls = true;
    }
  }

  if (!storagePath) {
    log.error("--storage-path is required");
    process.exit(1);
  }
  if (!relay && pinApps.length === 0) {
    log.error("at least one of --relay or --pin" + " is required");
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
    retentionFullMs,
    retentionHourlyMs,
    retentionDailyMs,
    ipnsRateLimit,
    staleResolveDays,
    noTls,
    tcpPort,
    wsPort,
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
    retentionFullMs,
    retentionHourlyMs,
    retentionDailyMs,
    ipnsRateLimit,
    staleResolveDays,
    noTls,
    tcpPort,
    wsPort,
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
    const roles = ["relay"];
    if (pinApps.length > 0) roles.push("pinner");
    relayHandle = await startRelay({
      storagePath,
      tcpPort: tcpPort ?? undefined,
      wsPort: wsPort ?? undefined,
      announceAddrs,
      roles,
      delegatedRoutingUrl: delegatedRoutingUrl ?? undefined,
      noTls,
    });
    log.info("relay started");
    for (const ma of relayHandle.multiaddrs()) {
      log.info(`  ${ma}`);
    }
  }

  // Start HTTPS block server when cert arrives
  let blockServer: HttpsServer | null = null;
  if (relayHandle && !noTls) {
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
        retentionPolicy: {
          fullResolutionMs: retentionFullMs,
          hourlyRetentionMs: retentionHourlyMs,
          dailyRetentionMs: retentionDailyMs,
        },
        getBlock: async (cid) => {
          try {
            const has = await blockstore.has(cid);
            if (!has) return null;
            return await blockstore.get(cid);
          } catch {
            return null;
          }
        },
        putBlock: async (cid, bytes) => {
          await blockstore.put(cid, bytes);
        },
        // Lazy check — pinner may not be created yet
        // when block server launches on existing cert.
        getHistory:
          pinApps.length > 0
            ? async (ipnsName) => {
                if (!pinner) return [];
                const records = pinner.history.getHistory(ipnsName);
                // Filter to blocks we still have
                const verified = [];
                for (const r of records) {
                  try {
                    const cid = CID.parse(r.cid);
                    if (await blockstore.has(cid)) {
                      verified.push(r);
                    }
                  } catch {
                    // Skip unparseable CIDs
                  }
                }
                return verified;
              }
            : undefined,
        // Lazy check — pinner may not be created yet
        // when block server launches on existing cert.
        getTipData:
          pinApps.length > 0
            ? async (ipnsName) => {
                if (!pinner) return null;
                return pinner.getTipData(ipnsName);
              }
            : undefined,
        getGuarantee:
          pinApps.length > 0
            ? (ipnsName) => {
                if (!pinner) return null;
                return pinner.getGuarantee(ipnsName);
              }
            : undefined,
        recordActivity:
          pinApps.length > 0
            ? (ipnsName) => {
                pinner?.recordActivity(ipnsName);
              }
            : undefined,
      });

      // Derive httpUrl: try SNI multiaddr first, then
      // fall back to extracting hostname from cert SAN.
      // At cert provision time, libp2p may not yet have
      // the SNI multiaddr registered.
      const wssAddr = relayHandle!
        .multiaddrs()
        .find((a) => a.includes("/tls/") && !a.includes("/p2p-circuit/"));
      let url = wssAddr ? deriveHttpUrl(wssAddr, httpsPort) : undefined;

      // Fallback: derive from cert SAN + relay IP
      if (!url) {
        url = deriveHttpUrlFromCert(
          cert.cert,
          relayHandle!.multiaddrs(),
          httpsPort,
        );
      }

      if (url) {
        relayHandle!.httpUrl = url;
        log.info(`block endpoint: ${url}`);
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
      ipnsRateLimit,
      staleResolveDays,
      retentionConfig: {
        fullResolutionMs: retentionFullMs,
        hourlyRetentionMs: retentionHourlyMs,
        dailyRetentionMs: retentionDailyMs,
      },
    });
    await pinner.start();
    log.info(`pinner started for: ${pinApps.join(", ")}`);

    // Subscribe to announcement topics for pinned
    // apps and wire GossipSub messages to pinner.
    // The relay auto-subscribes to topics its peers
    // need, but the pinner must subscribe explicitly
    // so it joins the mesh immediately on startup.
    if (relayHandle) {
      const topicToApp = new Map<string, string>();
      for (const app of pinApps) {
        const topic = announceTopic(app);
        topicToApp.set(topic, app);
        pubsub.subscribe(topic);
        log.info("pinner subscribed to", topic);
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
