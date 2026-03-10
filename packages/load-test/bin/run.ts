#!/usr/bin/env node

import { createMetrics } from "../src/metrics.js";
import { createLogger, setLogLevel } from "@pokapali/log";

const log = createLogger("load-test");

interface Config {
  docs: number;
  intervalMs: number;
  readers: number;
  durationS: number;
  bootstrap: string[];
  output: string | undefined;
  ramp: boolean;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    docs: 1,
    intervalMs: 5000,
    readers: 0,
    durationS: 60,
    bootstrap: [],
    output: undefined,
    ramp: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--docs" && argv[i + 1]) {
      config.docs = parseInt(argv[++i], 10);
    } else if (
      arg === "--interval" && argv[i + 1]
    ) {
      config.intervalMs = parseInt(argv[++i], 10);
    } else if (
      arg === "--readers" && argv[i + 1]
    ) {
      config.readers = parseInt(argv[++i], 10);
    } else if (
      arg === "--duration" && argv[i + 1]
    ) {
      config.durationS = parseInt(argv[++i], 10);
    } else if (
      arg === "--bootstrap" && argv[i + 1]
    ) {
      config.bootstrap.push(argv[++i]);
    } else if (
      arg === "--output" && argv[i + 1]
    ) {
      config.output = argv[++i];
    } else if (arg === "--ramp") {
      config.ramp = true;
    } else if (arg === "--log-level" && argv[i + 1]) {
      setLogLevel(argv[++i] as any);
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

async function main() {
  const config = parseArgs(process.argv);
  const metrics = createMetrics(config.output);

  log.info(
    `starting: ${config.docs} docs,`
    + ` ${config.intervalMs}ms interval,`
    + ` ${config.durationS}s duration`,
  );
  if (config.bootstrap.length > 0) {
    log.info(
      `  bootstrap: ${config.bootstrap.join(", ")}`,
    );
  }
  if (config.ramp) {
    log.info("  ramp: staggering doc creation");
  }

  // TODO: Wire up helia-node.ts + writer.ts once
  // core builds them. For now, the CLI validates
  // args and sets up metrics collection.
  //
  // Planned flow:
  // 1. Create Helia via createNodeHelia(bootstrap)
  // 2. For each doc (0..docs-1):
  //    a. Create capability (keypair)
  //    b. Create CollabDoc via createCollabDoc
  //    c. Start edit loop at intervalMs
  //    d. Listen for ack events → metrics.record
  //    If ramp: delay (i * intervalMs / docs)
  // 3. After durationS: stop all docs, metrics.finish

  const durationMs = config.durationS * 1000;

  // Placeholder: create doc events for validation
  for (let i = 0; i < config.docs; i++) {
    const docId = `doc-${i}`;
    metrics.record({
      ts: Date.now(),
      type: "doc-created",
      docId,
    });
  }

  log.info(
    `created ${config.docs} docs (stub),`
    + ` waiting ${config.durationS}s...`,
  );

  // Wait for duration then finish
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);

    function shutdown() {
      clearTimeout(timer);
      resolve();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  metrics.finish();
  log.info("done");
  process.exit(0);
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
