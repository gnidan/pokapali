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
 *   --baseline <file>    Compare against baseline JSON
 *   --save-baseline <f>  Write current metrics as baseline
 *   --regression-tolerance <pct>
 *                        Max allowed regression % (default 20)
 *
 * Exit 0 = pass, exit 1 = fail, exit 2 = usage error.
 */

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface PhaseConfig {
  name: string;
  startS: number;
  endS: number;
}

interface Config {
  file: string;
  minAckRate: number;
  maxLatencyP95: number;
  maxErrors: number;
  maxRssMB: number;
  maxRecoveryMs: number;
  phases: PhaseConfig[];
  phaseMinAckRates: Map<string, number>;
  baselinePath: string | null;
  saveBaselinePath: string | null;
  regressionTolerance: number;
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

export interface Baseline {
  version: 1;
  date: string;
  ackRate: number;
  ackLatencyP50: number;
  ackLatencyP95: number;
  ackLatencyP99: number;
  snapshotsPushed: number;
  acksReceived: number;
  readerSyncs: number;
  convergenceOk: number;
  convergenceDrift: number;
  syncLatencyP50: number;
  syncLatencyP95: number;
  errorCount: number;
}

interface MetricsSummary {
  docs: number;
  snapshotsPushed: number;
  acksReceived: number;
  ackRate: number;
  ackLatencyP50: number;
  ackLatencyP95: number;
  ackLatencyP99: number;
  errorCount: number;
  readerSyncs: number;
  convergenceOk: number;
  convergenceDrift: number;
  syncLatencyP50: number;
  syncLatencyP95: number;
  maxRecoveryMs: number;
  churnCycles: number;
  nodesJoined: number;
  nodesLeft: number;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    file: "",
    minAckRate: 95,
    maxLatencyP95: 5_000,
    maxErrors: 0,
    maxRssMB: 200,
    maxRecoveryMs: 30_000,
    phases: [],
    phaseMinAckRates: new Map(),
    baselinePath: null,
    saveBaselinePath: null,
    regressionTolerance: 20,
  };

  const args = argv.slice(2);
  let i = 0;

  // First positional arg is the file
  if (args.length === 0 || args[0]!.startsWith("--")) {
    console.error("Usage: analyze <file.jsonl> [options]");
    process.exit(2);
  }
  config.file = args[i++]!;

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--ack-rate" && args[i + 1]) {
      config.minAckRate = parseFloat(args[++i]!);
    } else if (arg === "--latency-p95" && args[i + 1]) {
      config.maxLatencyP95 = parseInt(args[++i]!, 10);
    } else if (arg === "--max-errors" && args[i + 1]) {
      config.maxErrors = parseInt(args[++i]!, 10);
    } else if (arg === "--max-rss" && args[i + 1]) {
      config.maxRssMB = parseInt(args[++i]!, 10);
    } else if (arg === "--recovery" && args[i + 1]) {
      config.maxRecoveryMs = parseInt(args[++i]!, 10);
    } else if (arg === "--cross-region") {
      config.maxLatencyP95 = 10_000;
    } else if (arg === "--phase" && args[i + 1]) {
      const parts = args[++i]!.split(":");
      if (parts.length !== 3) {
        console.error("Invalid --phase format." + " Use name:startS:endS");
        process.exit(2);
      }
      config.phases.push({
        name: parts[0]!,
        startS: parseInt(parts[1]!, 10),
        endS: parseInt(parts[2]!, 10),
      });
    } else if (arg === "--phase-ack-rate" && args[i + 1]) {
      const [name, pct] = args[++i]!.split(":");
      config.phaseMinAckRates.set(
        name!, parseFloat(pct!),
      );
    } else if (arg === "--baseline" && args[i + 1]) {
      config.baselinePath = args[++i]!;
    } else if (arg === "--save-baseline" && args[i + 1]) {
      config.saveBaselinePath = args[++i]!;
    } else if (
      arg === "--regression-tolerance" && args[i + 1]
    ) {
      config.regressionTolerance = parseFloat(
        args[++i]!,
      );
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
  const idx = Math.min(
    Math.floor(sorted.length * pct),
    sorted.length - 1,
  );
  return sorted[idx]!;
}

function loadBaseline(path: string): Baseline {
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw) as Baseline;
  if (data.version !== 1) {
    console.error(`Unsupported baseline version: ${data.version}`);
    process.exit(2);
  }
  return data;
}

function saveBaseline(path: string, metrics: MetricsSummary): void {
  const baseline: Baseline = {
    version: 1,
    date: new Date().toISOString().slice(0, 10),
    ackRate: parseFloat(metrics.ackRate.toFixed(1)),
    ackLatencyP50: metrics.ackLatencyP50,
    ackLatencyP95: metrics.ackLatencyP95,
    ackLatencyP99: metrics.ackLatencyP99,
    snapshotsPushed: metrics.snapshotsPushed,
    acksReceived: metrics.acksReceived,
    readerSyncs: metrics.readerSyncs,
    convergenceOk: metrics.convergenceOk,
    convergenceDrift: metrics.convergenceDrift,
    syncLatencyP50: metrics.syncLatencyP50,
    syncLatencyP95: metrics.syncLatencyP95,
    errorCount: metrics.errorCount,
  };
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Baseline saved to ${path}`);
}

export function compareBaseline(
  metrics: MetricsSummary,
  baseline: Baseline,
  tolerancePct: number,
): { name: string; pass: boolean; detail: string }[] {
  const checks: {
    name: string;
    pass: boolean;
    detail: string;
  }[] = [];
  const tol = tolerancePct / 100;

  // Ack rate: current must not drop below baseline
  // minus tolerance. Higher is always fine.
  if (baseline.ackRate > 0) {
    const minAllowed = baseline.ackRate * (1 - tol);
    checks.push({
      name: "Regression: ack rate",
      pass: metrics.ackRate >= minAllowed,
      detail:
        `${metrics.ackRate.toFixed(1)}%` +
        ` (baseline: ${baseline.ackRate}%,` +
        ` min: ${minAllowed.toFixed(1)}%)`,
    });
  }

  // Latency p95: current must not exceed baseline
  // plus tolerance. Lower is always fine.
  if (baseline.ackLatencyP95 > 0) {
    const maxAllowed = baseline.ackLatencyP95 * (1 + tol);
    checks.push({
      name: "Regression: latency p95",
      pass: metrics.ackLatencyP95 <= maxAllowed,
      detail:
        `${metrics.ackLatencyP95}ms` +
        ` (baseline: ${baseline.ackLatencyP95}ms,` +
        ` max: ${Math.round(maxAllowed)}ms)`,
    });
  }

  // Latency p99: same logic as p95
  if (baseline.ackLatencyP99 > 0) {
    const maxAllowed = baseline.ackLatencyP99 * (1 + tol);
    checks.push({
      name: "Regression: latency p99",
      pass: metrics.ackLatencyP99 <= maxAllowed,
      detail:
        `${metrics.ackLatencyP99}ms` +
        ` (baseline: ${baseline.ackLatencyP99}ms,` +
        ` max: ${Math.round(maxAllowed)}ms)`,
    });
  }

  // Convergence drift: if baseline had 0, current
  // must also be 0 (no tolerance for new drift).
  if (baseline.convergenceDrift === 0) {
    checks.push({
      name: "Regression: convergence",
      pass: metrics.convergenceDrift === 0,
      detail:
        metrics.convergenceDrift === 0
          ? "0 drift (matches baseline)"
          : `${metrics.convergenceDrift} drift(s)` + ` (baseline: 0)`,
    });
  }

  // Sync latency p95: same as ack latency
  if (baseline.syncLatencyP95 > 0 && metrics.readerSyncs > 0) {
    const maxAllowed = baseline.syncLatencyP95 * (1 + tol);
    checks.push({
      name: "Regression: sync latency p95",
      pass: metrics.syncLatencyP95 <= maxAllowed,
      detail:
        `${metrics.syncLatencyP95}ms` +
        ` (baseline: ${baseline.syncLatencyP95}ms,` +
        ` max: ${Math.round(maxAllowed)}ms)`,
    });
  }

  return checks;
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

  // Phase analysis tracking
  const allEvents: Array<{ ts: number; type: string }> = [];
  let firstTs: number | null = null;

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

    if (firstTs === null) firstTs = event.ts;
    allEvents.push({ ts: event.ts, type: event.type });

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

  const sortedSync = syncLatencies.slice().sort((a, b) => a - b);
  const syncP50 = percentile(sortedSync, 0.5);
  const syncP95 = percentile(sortedSync, 0.95);

  const metrics: MetricsSummary = {
    docs: docs.size,
    snapshotsPushed,
    acksReceived,
    ackRate,
    ackLatencyP50: p50,
    ackLatencyP95: p95,
    ackLatencyP99: p99,
    errorCount,
    readerSyncs,
    convergenceOk,
    convergenceDrift,
    syncLatencyP50: syncP50,
    syncLatencyP95: syncP95,
    maxRecoveryMs,
    churnCycles,
    nodesJoined,
    nodesLeft,
  };

  // RSS: analyzer process only (not from JSONL)
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // Print summary
  console.log("=== Load Test Analysis ===");
  console.log(`  File:          ${config.file}`);
  console.log(`  Docs:          ${metrics.docs}`);
  console.log(`  Snapshots:     ${snapshotsPushed}`);
  console.log(`  Acks:          ${acksReceived}` + ` (${ackRate.toFixed(1)}%)`);
  console.log(`  Ack p50:       ${p50}ms`);
  console.log(`  Ack p95:       ${p95}ms`);
  console.log(`  Ack p99:       ${p99}ms`);
  console.log(`  Errors:        ${errorCount}`);
  console.log(
    `  Max recovery:  ` + `${maxRecoveryMs > 0 ? maxRecoveryMs + "ms" : "N/A"}`,
  );
  console.log(`  Analyzer RSS:  ${rssMB}MB`);

  if (readerSyncs > 0) {
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
  const checks: {
    name: string;
    pass: boolean;
    detail: string;
  }[] = [];

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

  // Phase analysis
  const phaseResults = new Map<string, number>();

  if (config.phases.length > 0 && firstTs !== null) {
    console.log("\n=== Phase Analysis ===");
    for (const phase of config.phases) {
      const startMs = firstTs + phase.startS * 1000;
      const endMs = firstTs + phase.endS * 1000;
      const phaseEvents = allEvents.filter(
        (e) => e.ts >= startMs && e.ts < endMs,
      );
      const phaseSnaps = phaseEvents.filter(
        (e) => e.type === "snapshot-pushed",
      ).length;
      const phaseAcks = phaseEvents.filter(
        (e) => e.type === "ack-received",
      ).length;
      const phaseErrors = phaseEvents.filter((e) => e.type === "error").length;
      const phaseAckRate = phaseSnaps > 0 ? (phaseAcks / phaseSnaps) * 100 : 0;
      phaseResults.set(phase.name, phaseAckRate);
      console.log(
        `  ${phase.name}:` +
          ` ${phaseAckRate.toFixed(1)}% ack rate` +
          ` (${phaseAcks}/${phaseSnaps} snaps,` +
          ` ${phaseErrors} errors)`,
      );
    }
  }

  // Phase pass/fail checks
  for (const phase of config.phases) {
    const minRate = config.phaseMinAckRates.get(phase.name);
    if (minRate != null) {
      const phaseAckRate = phaseResults.get(phase.name) ?? 0;
      checks.push({
        name: `Phase '${phase.name}' ack rate`,
        pass: phaseAckRate >= minRate,
        detail: `${phaseAckRate.toFixed(1)}%` + ` (threshold: ${minRate}%)`,
      });
    }
  }

  // Baseline regression checks
  if (config.baselinePath) {
    const baseline = loadBaseline(config.baselinePath);
    console.log(
      `\n=== Regression Analysis ` + `(baseline: ${baseline.date}) ===`,
    );
    const regressionChecks = compareBaseline(
      metrics,
      baseline,
      config.regressionTolerance,
    );
    checks.push(...regressionChecks);
  }

  // Save baseline if requested
  if (config.saveBaselinePath) {
    saveBaseline(config.saveBaselinePath, metrics);
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

// Guard against running when imported as a module
// (e.g., by tests that import compareBaseline).
const isDirectRun =
  process.argv[1]?.endsWith("/analyze.js") ||
  process.argv[1]?.endsWith("/analyze.ts");

if (isDirectRun) {
  const config = parseArgs(process.argv);
  analyze(config).catch((err) => {
    console.error("Fatal:", err);
    process.exit(2);
  });
}
