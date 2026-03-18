#!/usr/bin/env node

import { createMetrics } from "../src/metrics.js";
import { createHeliaNode, type HeliaNode } from "../src/helia-node.js";
import { startWriter, type Writer, type WriterEvent } from "../src/writer.js";
import {
  startReaderPeer,
  type ReaderPeer,
  type ReaderPeerEvent,
} from "../src/reader-peer.js";
import { startChurnScheduler } from "../src/churn.js";
import { createLogger, setLogLevel } from "@pokapali/log";

const log = createLogger("load-test:churn");

interface Config {
  writers: number;
  readers: number;
  churnIntervalMs: number;
  churnSize: number;
  stabilizeMs: number;
  editIntervalMs: number;
  editSizeBytes: number;
  durationS: number;
  bootstrap: string[];
  httpUrls: string[];
  output: string | undefined;
  appId: string;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    writers: 3,
    readers: 2,
    churnIntervalMs: 30_000,
    churnSize: 1,
    stabilizeMs: 5_000,
    editIntervalMs: 5_000,
    editSizeBytes: 100,
    durationS: 120,
    bootstrap: [],
    httpUrls: [],
    output: undefined,
    appId: "pokapali-load-test",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--writers" && argv[i + 1]) {
      config.writers = parseInt(argv[++i]!, 10);
    } else if (arg === "--readers" && argv[i + 1]) {
      config.readers = parseInt(argv[++i]!, 10);
    } else if (arg === "--churn-interval" && argv[i + 1]) {
      config.churnIntervalMs = parseInt(argv[++i]!, 10);
    } else if (arg === "--churn-size" && argv[i + 1]) {
      config.churnSize = parseInt(argv[++i]!, 10);
    } else if (arg === "--stabilize" && argv[i + 1]) {
      config.stabilizeMs = parseInt(argv[++i]!, 10);
    } else if (arg === "--interval" && argv[i + 1]) {
      config.editIntervalMs = parseInt(argv[++i]!, 10);
    } else if (arg === "--edit-size" && argv[i + 1]) {
      config.editSizeBytes = parseInt(argv[++i]!, 10);
    } else if (arg === "--duration" && argv[i + 1]) {
      config.durationS = parseInt(argv[++i]!, 10);
    } else if (arg === "--bootstrap" && argv[i + 1]) {
      config.bootstrap.push(argv[++i]!);
    } else if (arg === "--http-url" && argv[i + 1]) {
      config.httpUrls.push(argv[++i]!);
    } else if (arg === "--output" && argv[i + 1]) {
      config.output = argv[++i]!;
    } else if (arg === "--app-id" && argv[i + 1]) {
      config.appId = argv[++i]!;
    } else if (arg === "--log-level" && argv[i + 1]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setLogLevel(argv[++i]! as any);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(1);
    }
  }

  return config;
}

function mapWriterEvent(
  event: WriterEvent,
  docId: string,
): Parameters<ReturnType<typeof createMetrics>["record"]>[0] | null {
  switch (event.type) {
    case "snapshot-pushed":
      return {
        ts: event.timestampMs,
        type: "snapshot-pushed",
        docId,
        latencyMs: event.durationMs,
        cid: event.cid,
      };
    case "ack-received":
      return {
        ts: event.timestampMs,
        type: "ack-received",
        docId,
        detail: event.ackerPeerId,
        cid: event.cid,
        guaranteeUntil: event.guaranteeUntil,
        retainUntil: event.retainUntil,
      };
    case "error":
      return {
        ts: event.timestampMs,
        type: "error",
        docId,
        detail: event.error,
      };
    default:
      return null;
  }
}

function mapReaderEvent(
  event: ReaderPeerEvent,
): Parameters<ReturnType<typeof createMetrics>["record"]>[0] | null {
  const docId = event.ipnsName
    ? `reader:${event.ipnsName.slice(0, 12)}`
    : "reader:unknown";
  switch (event.type) {
    case "reader-synced":
      return {
        ts: event.timestampMs,
        type: "reader-synced",
        docId,
        latencyMs: event.latencyMs,
        cid: event.cid,
      };
    case "convergence-ok":
      return {
        ts: event.timestampMs,
        type: "convergence-ok",
        docId,
        expectedClockSum: event.expectedClockSum,
        actualClockSum: event.actualClockSum,
      };
    case "convergence-drift":
      return {
        ts: event.timestampMs,
        type: "convergence-drift",
        docId,
        expectedClockSum: event.expectedClockSum,
        actualClockSum: event.actualClockSum,
      };
    case "error":
      return {
        ts: event.timestampMs,
        type: "error",
        docId: `reader:${event.peerId}`,
        detail: event.error,
      };
    default:
      return null;
  }
}

async function main() {
  const config = parseArgs(process.argv);
  const metrics = createMetrics(config.output);

  log.info(
    `churn: ${config.writers} writers,` +
      ` ${config.readers} readers,` +
      ` churn every ${config.churnIntervalMs}ms,` +
      ` size=${config.churnSize},` +
      ` stabilize=${config.stabilizeMs}ms,` +
      ` duration=${config.durationS}s`,
  );

  // Create writer Helia node
  log.info("creating writer Helia node...");
  const writerHelia: HeliaNode = await createHeliaNode({
    bootstrapPeers: config.bootstrap,
  });
  log.info("writer Helia ready");

  // Create reader Helia node if readers > 0
  let readerHelia: HeliaNode | null = null;
  if (config.readers > 0) {
    log.info("creating reader Helia node...");
    readerHelia = await createHeliaNode({
      bootstrapPeers: config.bootstrap,
    });
    log.info("reader Helia ready");

    // Connect reader to writer for GossipSub mesh
    const writerAddrs = writerHelia.libp2p.getMultiaddrs();
    for (const ma of writerAddrs) {
      try {
        await readerHelia.libp2p.dial(ma);
        log.info("reader dialed writer:", ma.toString().slice(-30));
        break;
      } catch {
        // try next addr
      }
    }
  }

  // Track active nodes for cleanup
  const activeWriters = new Map<string, Writer>();
  const activeReaders = new Map<string, ReaderPeer>();
  let writerCounter = 0;

  // Writer readKey map for reader peers
  const writerKeys = new Map<string, CryptoKey>();

  const scheduler = await startChurnScheduler(
    {
      baselineWriters: config.writers,
      baselineReaders: config.readers,
      churnIntervalMs: config.churnIntervalMs,
      churnSize: config.churnSize,
      stabilizeMs: config.stabilizeMs,
    },
    {
      async addWriter() {
        const docId = `churn-doc-${writerCounter++}`;
        const writer = await startWriter(writerHelia, {
          appId: config.appId,
          editIntervalMs: config.editIntervalMs,
          editSizeBytes: config.editSizeBytes,
          httpUrls: config.httpUrls,
          onEvent(event: WriterEvent) {
            const mapped = mapWriterEvent(event, docId);
            if (mapped) metrics.record(mapped);
          },
        });
        activeWriters.set(docId, writer);
        writerKeys.set(writer.ipnsName, writer.readKey);
        metrics.record({
          ts: Date.now(),
          type: "doc-created",
          docId,
        });
        log.info(`writer ${writer.writerId} → ${docId}`);
        return docId;
      },

      async removeWriter(id: string) {
        const writer = activeWriters.get(id);
        if (writer) {
          writer.stop();
          writerKeys.delete(writer.ipnsName);
          activeWriters.delete(id);
          log.info(`writer ${writer.writerId} removed`);
        }
      },

      async addReader() {
        if (!readerHelia) return "";
        const peer = startReaderPeer(readerHelia.libp2p.services.pubsub, {
          appId: config.appId,
          writers: writerKeys,
          onEvent(event: ReaderPeerEvent) {
            const mapped = mapReaderEvent(event);
            if (mapped) metrics.record(mapped);
          },
        });
        activeReaders.set(peer.peerId, peer);
        log.info(`reader ${peer.peerId} started`);
        return peer.peerId;
      },

      async removeReader(id: string) {
        const peer = activeReaders.get(id);
        if (peer) {
          peer.stop();
          activeReaders.delete(id);
          log.info(`reader ${id} removed`);
        }
      },

      onEvent(event) {
        metrics.record(event);
      },
    },
  );

  log.info("churn scheduler running...");

  // Wait for duration
  const durationMs = config.durationS * 1000;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    function shutdown() {
      clearTimeout(timer);
      resolve();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  // Shutdown
  log.info("stopping churn scheduler...");
  scheduler.stop();

  for (const r of activeReaders.values()) {
    r.stop();
  }
  for (const w of activeWriters.values()) {
    w.stop();
  }

  log.info("stopping Helia...");
  await writerHelia.stop();
  if (readerHelia) await readerHelia.stop();

  metrics.finish();
  log.info(`done — ${scheduler.cycleCount} churn cycles`);
  process.exit(0);
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
