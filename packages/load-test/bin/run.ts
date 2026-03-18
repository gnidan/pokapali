#!/usr/bin/env node

import { createMetrics } from "../src/metrics.js";
import { createHeliaNode, type HeliaNode } from "../src/helia-node.js";
import { startWriter, type Writer, type WriterEvent } from "../src/writer.js";
import {
  startReaderPeer,
  type ReaderPeer,
  type ReaderPeerEvent,
} from "../src/reader-peer.js";
import { createLogger, setLogLevel } from "@pokapali/log";

const log = createLogger("load-test");

interface Config {
  docs: number;
  intervalMs: number;
  editSizeBytes: number;
  readers: number;
  durationS: number;
  bootstrap: string[];
  httpUrls: string[];
  output: string | undefined;
  ramp: boolean;
  appId: string;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    docs: 1,
    intervalMs: 5000,
    editSizeBytes: 100,
    readers: 0,
    durationS: 60,
    bootstrap: [],
    httpUrls: [],
    output: undefined,
    ramp: false,
    appId: "pokapali-example",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--docs" && argv[i + 1]) {
      config.docs = parseInt(argv[++i]!, 10);
    } else if (arg === "--interval" && argv[i + 1]) {
      config.intervalMs = parseInt(argv[++i]!, 10);
    } else if (arg === "--edit-size" && argv[i + 1]) {
      config.editSizeBytes = parseInt(argv[++i]!, 10);
    } else if (arg === "--readers" && argv[i + 1]) {
      config.readers = parseInt(argv[++i]!, 10);
    } else if (arg === "--duration" && argv[i + 1]) {
      config.durationS = parseInt(argv[++i]!, 10);
    } else if (arg === "--bootstrap" && argv[i + 1]) {
      config.bootstrap.push(argv[++i]!);
    } else if (arg === "--http-url" && argv[i + 1]) {
      config.httpUrls.push(argv[++i]!);
    } else if (arg === "--output" && argv[i + 1]) {
      config.output = argv[++i]!;
    } else if (arg === "--ramp") {
      config.ramp = true;
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

  if (config.docs < 1) {
    console.error("--docs must be >= 1");
    process.exit(1);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const config = parseArgs(process.argv);
  const metrics = createMetrics(config.output);

  log.info(
    `starting: ${config.docs} docs,` +
      ` ${config.readers} readers,` +
      ` ${config.intervalMs}ms interval,` +
      ` ${config.editSizeBytes}B edits,` +
      ` ${config.durationS}s duration,` +
      ` appId=${config.appId}`,
  );
  if (config.bootstrap.length > 0) {
    log.info(`  bootstrap: ${config.bootstrap.join(", ")}`);
  }
  if (config.ramp) {
    log.info("  ramp: staggering doc creation");
  }

  // Create writer Helia node
  log.info("creating Helia node...");
  const helia: HeliaNode = await createHeliaNode({
    bootstrapPeers: config.bootstrap,
  });
  log.info("Helia ready");

  const durationMs = config.durationS * 1000;
  const writers: Writer[] = [];

  // Spawn writers
  const rampDelay =
    config.ramp && config.docs > 1 ? durationMs / config.docs : 0;

  for (let i = 0; i < config.docs; i++) {
    const docId = `doc-${i}`;

    if (config.ramp && i > 0) {
      log.info(`ramp: waiting ${rampDelay}ms` + ` before doc ${i}...`);
      await sleep(rampDelay);
    }

    const writer = await startWriter(helia, {
      appId: config.appId,
      editIntervalMs: config.intervalMs,
      editSizeBytes: config.editSizeBytes,
      httpUrls: config.httpUrls,
      onEvent(event: WriterEvent) {
        const mapped = mapWriterEvent(event, docId);
        if (mapped) metrics.record(mapped);
      },
    });

    writers.push(writer);
    metrics.record({
      ts: Date.now(),
      type: "doc-created",
      docId,
    });
    log.info(`writer ${writer.writerId} → ${docId}`);
  }

  // Spawn reader peers
  const readerPeers: ReaderPeer[] = [];
  let readerHelia: HeliaNode | null = null;

  if (config.readers > 0) {
    const writerKeys = new Map<string, CryptoKey>();
    for (const w of writers) {
      writerKeys.set(w.ipnsName, w.readKey);
    }

    log.info("creating reader Helia node...");
    readerHelia = await createHeliaNode({
      bootstrapPeers: config.bootstrap,
    });
    log.info("reader Helia ready");

    // Connect reader to writer for GossipSub mesh
    const writerAddrs = helia.libp2p.getMultiaddrs();
    for (const ma of writerAddrs) {
      try {
        await readerHelia.libp2p.dial(ma);
        log.info("reader dialed writer:", ma.toString().slice(-30));
        break;
      } catch {
        // try next addr
      }
    }

    for (let i = 0; i < config.readers; i++) {
      const peer = startReaderPeer(readerHelia.libp2p.services.pubsub, {
        appId: config.appId,
        writers: writerKeys,
        onEvent(event: ReaderPeerEvent) {
          const mapped = mapReaderEvent(event);
          if (mapped) metrics.record(mapped);
        },
      });
      readerPeers.push(peer);
      log.info(`${peer.peerId} started`);
    }
  }

  log.info(
    `${writers.length} writers,` +
      ` ${readerPeers.length} readers running,` +
      ` waiting ${config.durationS}s...`,
  );

  // Wait for duration then shutdown
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);

    function shutdown() {
      clearTimeout(timer);
      resolve();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  // Stop readers first
  for (const r of readerPeers) {
    r.stop();
  }

  // Stop all writers
  log.info("stopping writers...");
  for (const w of writers) {
    w.stop();
  }

  // Stop Helia nodes
  log.info("stopping Helia...");
  await helia.stop();
  if (readerHelia) await readerHelia.stop();

  metrics.finish();
  log.info("done");
  process.exit(0);
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
