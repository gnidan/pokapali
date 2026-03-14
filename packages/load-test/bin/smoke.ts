#!/usr/bin/env node

/**
 * CI smoke load test.
 *
 * Starts an ephemeral test relay, spawns 5 writers and
 * 1 reader, runs for 30s, then checks:
 *   - Reader received announcements from all 5 docs
 *   - Zero errors
 *   - Peak RSS < 200MB
 *
 * Exit 0 = pass, exit 1 = fail.
 */

import { createTestRelay } from "@pokapali/test-utils";
import { createHeliaNode, type HeliaNode } from "../src/helia-node.js";
import { startWriter, type Writer, type WriterEvent } from "../src/writer.js";
import { startReader, type Reader } from "../src/reader.js";
import { createMetrics } from "../src/metrics.js";
import { createLogger, setLogLevel } from "@pokapali/log";

const log = createLogger("load-test:smoke");

const APP_ID = "pokapali-smoke-test";
const DOC_COUNT = 5;
const EDIT_INTERVAL_MS = 5_000;
const DURATION_S = 30;
const MAX_RSS_MB = 200;

/** Wait for GossipSub mesh to form between peers. */
const MESH_SETTLE_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const outputPath = process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : undefined;

  if (process.argv.includes("--log-level")) {
    const level = process.argv[process.argv.indexOf("--log-level") + 1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setLogLevel(level as any);
  }

  const metrics = createMetrics(outputPath);
  const errors: string[] = [];

  // 1. Start ephemeral test relay
  log.info("starting test relay...");
  const relay = await createTestRelay();
  log.info(`relay ready: ${relay.multiaddr}`);

  // 2. Create writer Helia node
  log.info("creating writer node...");
  const writerNode: HeliaNode = await createHeliaNode({
    bootstrapPeers: [relay.multiaddr],
  });
  log.info("writer node ready");

  // 3. Create reader Helia node
  log.info("creating reader node...");
  const readerNode: HeliaNode = await createHeliaNode({
    bootstrapPeers: [relay.multiaddr],
  });
  log.info("reader node ready");

  // 4. Connect reader directly to writer for
  //    GossipSub mesh formation. The test relay
  //    doesn't subscribe to app topics, so it
  //    can't forward GossipSub messages. Direct
  //    connection lets the mesh form peer-to-peer.
  const writerAddrs = writerNode.libp2p.getMultiaddrs();
  for (const ma of writerAddrs) {
    try {
      await readerNode.libp2p.dial(ma);
      log.info("reader dialed writer:", ma.toString().slice(-30));
      break;
    } catch {
      // try next addr
    }
  }

  // 5. Start reader
  const reader: Reader = startReader(readerNode, {
    appId: APP_ID,
    onEvent(event) {
      if (event.type === "error" && event.error) {
        errors.push(event.error);
      }
    },
  });

  // 6. Let GossipSub mesh settle
  log.info(`waiting ${MESH_SETTLE_MS}ms for mesh to form...`);
  await sleep(MESH_SETTLE_MS);

  // 7. Spawn writers
  const writers: Writer[] = [];
  const writerIpnsNames: string[] = [];

  for (let i = 0; i < DOC_COUNT; i++) {
    const docId = `smoke-doc-${i}`;
    const writer = await startWriter(writerNode, {
      appId: APP_ID,
      editIntervalMs: EDIT_INTERVAL_MS,
      editSizeBytes: 100,
      onEvent(event: WriterEvent) {
        if (event.type === "error" && event.error) {
          errors.push(event.error);
        }
        // Map to metrics
        if (event.type === "snapshot-pushed") {
          metrics.record({
            ts: event.timestampMs,
            type: "snapshot-pushed",
            docId,
            latencyMs: event.durationMs,
            cid: event.cid,
          });
        }
      },
    });
    writers.push(writer);
    writerIpnsNames.push(writer.ipnsName);
    metrics.record({
      ts: Date.now(),
      type: "doc-created",
      docId,
    });
    log.info(`writer ${writer.writerId} → ${docId}`);
  }

  log.info(`${DOC_COUNT} writers running,` + ` waiting ${DURATION_S}s...`);

  // 8. Wait for duration
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, DURATION_S * 1000);

    function shutdown() {
      clearTimeout(timer);
      resolve();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  // 9. Stop everything
  log.info("stopping writers...");
  for (const w of writers) {
    w.stop();
  }

  // Give a moment for final messages to arrive
  await sleep(2_000);

  reader.stop();

  log.info("stopping nodes...");
  await writerNode.stop();
  await readerNode.stop();
  await relay.stop();

  metrics.finish();

  // 10. Check pass/fail criteria
  const peakRssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const seenNames = reader.seen;
  const missedDocs = writerIpnsNames.filter((name) => !seenNames.has(name));

  console.error("\n--- Smoke Test Results ---");
  console.error(`  Docs:        ${DOC_COUNT}`);
  console.error(`  Reader seen: ${seenNames.size}/${DOC_COUNT} docs`);
  console.error(`  Announcements: ${reader.announcementCount}`);
  console.error(`  Errors:      ${errors.length}`);
  console.error(`  Peak RSS:    ${peakRssMB}MB`);

  let pass = true;

  if (missedDocs.length > 0) {
    console.error(`\nFAIL: reader missed ${missedDocs.length}` + ` doc(s):`);
    for (const name of missedDocs) {
      console.error(`  - ${name.slice(0, 16)}...`);
    }
    pass = false;
  }

  if (errors.length > 0) {
    console.error(`\nFAIL: ${errors.length} error(s):`);
    for (const e of errors.slice(0, 5)) {
      console.error(`  - ${e}`);
    }
    pass = false;
  }

  if (peakRssMB > MAX_RSS_MB) {
    console.error(
      `\nFAIL: peak RSS ${peakRssMB}MB` + ` exceeds ${MAX_RSS_MB}MB limit`,
    );
    pass = false;
  }

  if (pass) {
    console.error("\nPASS");
    process.exit(0);
  } else {
    console.error("\nFAIL");
    process.exit(1);
  }
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
