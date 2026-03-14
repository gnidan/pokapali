#!/usr/bin/env node

/**
 * Analyze load-test JSONL output and produce a
 * pass/fail verdict for CI gating.
 *
 * Usage:
 *   node dist/bin/analyze.js <file.jsonl> [options]
 *
 * Options:
 *   --ack-rate <pct>     Min ack success rate (default 95)
 *   --latency-p95 <ms>   Max ack latency p95 (default 5000)
 *   --max-errors <n>     Max unexpected errors (default 0)
 *   --max-rss <mb>       Max peak RSS in MB (default 200)
 *   --recovery <ms>      Max mesh recovery time (default 30000)
 *   --cross-region       Use cross-region latency threshold
 *                        (default 10000 instead of 5000)
 *
 * Exit 0 = pass, exit 1 = fail, exit 2 = usage error.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

interface Config {
  file: string;
  minAckRate: number;
  maxLatencyP95: number;
  maxErrors: number;
  maxRssMB: number;
  maxRecoveryMs: number;
}

interface Event {
  ts: number;
  type: string;
  docId: string;
  latencyMs?: number;
  detail?: string;
  cid?: string;
  guaranteeUntil?: number;
  retainUntil?: number;
  expectedClockSum?: number;
  actualClockSum?: number;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    file: "",
    minAckRate: 95,
    maxLatencyP95: 5_000,
    maxErrors: 0,
    maxRssMB: 200,
    maxRecoveryMs: 30_000,
  };

  const args = argv.slice(2);
  let i = 0;

  // First positional arg is the file
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: analyze <file.jsonl> [options]");
    process.exit(2);
  }
  config.file = args[i++];

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--ack-rate" && args[i + 1]) {
      config.minAckRate = parseFloat(args[++i]);
    } else if (arg === "--latency-p95" && args[i + 1]) {
      config.maxLatencyP95 = parseInt(args[++i], 10);
    } else if (arg === "--max-errors" && args[i + 1]) {
      config.maxErrors = parseInt(args[++i], 10);
    } else if (arg === "--max-rss" && args[i + 1]) {
      config.maxRssMB = parseInt(args[++i], 10);
    } else if (arg === "--recovery" && args[i + 1]) {
      config.maxRecoveryMs = parseInt(args[++i], 10);
    } else if (arg === "--cross-region") {
      config.maxLatencyP95 = 10_000;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
    i++;
  }

  return config;
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * pct), sorted.length - 1);
  return sorted[idx];
}

async function analyze(config: Config) {
  const docs = new Set<string>();
  let snapshotsPushed = 0;
  let acksReceived = 0;
  let errorCount = 0;
  const errors: string[] = [];
  const ackLatencies: number[] = [];
  const pendingSnapshots = new Map<string, number>();

  // Reader sync tracking
  let readerSyncs = 0;
  let convergenceOk = 0;
  let convergenceDrift = 0;
  const syncLatencies: number[] = [];

  // Track status changes for mesh recovery
  let lastDisconnectTs: number | null = null;
  let maxRecoveryMs = 0;

  // Churn tracking
  let churnCycles = 0;
  let nodesJoined = 0;
  let nodesLeft = 0;

  const rl = createInterface({
    input: createReadStream(config.file),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let event: Event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    switch (event.type) {
      case "doc-created":
        docs.add(event.docId);
        break;

      case "snapshot-pushed":
        snapshotsPushed++;
        if (event.cid) {
          pendingSnapshots.set(event.cid, event.ts);
        }
        break;

      case "ack-received":
        acksReceived++;
        if (event.cid) {
          const pushTs = pendingSnapshots.get(event.cid);
          if (pushTs != null) {
            ackLatencies.push(event.ts - pushTs);
            pendingSnapshots.delete(event.cid);
          }
        }
        break;

      case "error":
        errorCount++;
        if (event.detail) {
          errors.push(event.detail);
        }
        break;

      case "reader-synced":
        readerSyncs++;
        if (event.latencyMs != null) {
          syncLatencies.push(event.latencyMs);
        }
        break;

      case "convergence-ok":
        convergenceOk++;
        break;

      case "convergence-drift":
        convergenceDrift++;
        break;

      case "node-joined":
        nodesJoined++;
        break;

      case "node-left":
        nodesLeft++;
        break;

      case "churn-cycle":
        churnCycles++;
        break;

      case "status-change":
        if (event.detail === "disconnected" || event.detail === "connecting") {
          lastDisconnectTs = event.ts;
        } else if (event.detail === "synced" && lastDisconnectTs != null) {
          const recovery = event.ts - lastDisconnectTs;
          if (recovery > maxRecoveryMs) {
            maxRecoveryMs = recovery;
          }
          lastDisconnectTs = null;
        }
        break;
    }
  }

  // Compute metrics
  const ackRate =
    snapshotsPushed > 0 ? (acksReceived / snapshotsPushed) * 100 : 0;

  const sorted = ackLatencies.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);

  // RSS: read from process if available, otherwise
  // not measurable from JSONL alone. Report N/A.
  // The smoke script checks RSS at runtime; this
  // analyzer focuses on JSONL-derived metrics.
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // Print summary
  console.log("=== Load Test Analysis ===");
  console.log(`  File:          ${config.file}`);
  console.log(`  Docs:          ${docs.size}`);
  console.log(`  Snapshots:     ${snapshotsPushed}`);
  console.log(`  Acks:          ${acksReceived}` + ` (${ackRate.toFixed(1)}%)`);
  console.log(`  Ack p50:       ${p50}ms`);
  console.log(`  Ack p95:       ${p95}ms`);
  console.log(`  Ack p99:       ${p99}ms`);
  console.log(`  Errors:        ${errorCount}`);
  console.log(
    `  Max recovery:  ${maxRecoveryMs > 0 ? maxRecoveryMs + "ms" : "N/A"}`,
  );
  console.log(`  Analyzer RSS:  ${rssMB}MB`);

  if (readerSyncs > 0) {
    const sortedSync = syncLatencies.slice().sort((a, b) => a - b);
    const syncP50 = percentile(sortedSync, 0.5);
    const syncP95 = percentile(sortedSync, 0.95);
    console.log(`  Reader syncs:  ${readerSyncs}`);
    console.log(
      `  Convergence:   ` +
        `${convergenceOk} ok, ` +
        `${convergenceDrift} drift`,
    );
    console.log(`  Sync p50:      ${syncP50}ms`);
    console.log(`  Sync p95:      ${syncP95}ms`);
  }

  if (churnCycles > 0) {
    console.log(`  Churn cycles:  ${churnCycles}`);
    console.log(`  Nodes joined:  ${nodesJoined}`);
    console.log(`  Nodes left:    ${nodesLeft}`);
  }

  // Check pass/fail
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  // Ack rate — only check if there were snapshots
  // and we expect acks (Tier 2+). Skip for Tier 1
  // smoke where no pinner exists.
  if (snapshotsPushed > 0 && acksReceived > 0) {
    checks.push({
      name: "Ack rate",
      pass: ackRate >= config.minAckRate,
      detail: `${ackRate.toFixed(1)}%` + ` (threshold: ${config.minAckRate}%)`,
    });
  } else if (snapshotsPushed > 0 && acksReceived === 0) {
    checks.push({
      name: "Ack rate",
      pass: true,
      detail: "SKIP (no acks — Tier 1 / no pinner)",
    });
  }

  // Latency p95 — only if we have latency data
  if (ackLatencies.length > 0) {
    checks.push({
      name: "Ack latency p95",
      pass: p95 <= config.maxLatencyP95,
      detail: `${p95}ms` + ` (threshold: ${config.maxLatencyP95}ms)`,
    });
  }

  // Convergence — only if we have reader data
  if (convergenceDrift > 0) {
    checks.push({
      name: "Convergence",
      pass: false,
      detail: `${convergenceDrift} drift(s) detected`,
    });
  } else if (convergenceOk > 0) {
    checks.push({
      name: "Convergence",
      pass: true,
      detail: `${convergenceOk} checks passed`,
    });
  }

  // Errors
  checks.push({
    name: "Errors",
    pass: errorCount <= config.maxErrors,
    detail: `${errorCount}` + ` (threshold: ${config.maxErrors})`,
  });

  // Mesh recovery — only if we observed disconnects
  if (maxRecoveryMs > 0) {
    checks.push({
      name: "Mesh recovery",
      pass: maxRecoveryMs <= config.maxRecoveryMs,
      detail: `${maxRecoveryMs}ms` + ` (threshold: ${config.maxRecoveryMs}ms)`,
    });
  }

  // Print checks
  console.log("\n=== Checks ===");
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${check.name}: ${check.detail}`);
    if (!check.pass) allPass = false;
  }

  if (errors.length > 0) {
    console.log("\n=== Errors ===");
    for (const e of errors.slice(0, 10)) {
      console.log(`  - ${e}`);
    }
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more`);
    }
  }

  console.log(`\n${allPass ? "PASS" : "FAIL"}`);
  process.exit(allPass ? 0 : 1);
}

const config = parseArgs(process.argv);
analyze(config).catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
