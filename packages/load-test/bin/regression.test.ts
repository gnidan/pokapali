import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compareBaseline } from "./analyze.js";
import type { Baseline } from "./analyze.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Unit tests for compareBaseline ---

describe("compareBaseline", () => {
  const baseline: Baseline = {
    version: 1,
    date: "2026-03-14",
    ackRate: 486.5,
    ackLatencyP50: 102,
    ackLatencyP95: 2113,
    ackLatencyP99: 2888,
    snapshotsPushed: 3043,
    acksReceived: 14805,
    readerSyncs: 14965,
    convergenceOk: 14965,
    convergenceDrift: 0,
    syncLatencyP50: 10,
    syncLatencyP95: 33,
    errorCount: 0,
  };

  it("all pass when metrics match baseline", () => {
    const metrics = {
      docs: 50,
      snapshotsPushed: 3043,
      acksReceived: 14805,
      ackRate: 486.5,
      ackLatencyP50: 102,
      ackLatencyP95: 2113,
      ackLatencyP99: 2888,
      errorCount: 0,
      readerSyncs: 14965,
      convergenceOk: 14965,
      convergenceDrift: 0,
      syncLatencyP50: 10,
      syncLatencyP95: 33,
      maxRecoveryMs: 0,
      churnCycles: 0,
      nodesJoined: 0,
      nodesLeft: 0,
    };
    const checks = compareBaseline(metrics, baseline, 20);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it("fails on ack rate regression beyond tolerance", () => {
    const metrics = {
      docs: 50,
      snapshotsPushed: 3043,
      acksReceived: 10000,
      ackRate: 328.6,
      ackLatencyP50: 102,
      ackLatencyP95: 2113,
      ackLatencyP99: 2888,
      errorCount: 0,
      readerSyncs: 14965,
      convergenceOk: 14965,
      convergenceDrift: 0,
      syncLatencyP50: 10,
      syncLatencyP95: 33,
      maxRecoveryMs: 0,
      churnCycles: 0,
      nodesJoined: 0,
      nodesLeft: 0,
    };
    const checks = compareBaseline(metrics, baseline, 20);
    const ackCheck = checks.find((c) => c.name === "Regression: ack rate");
    expect(ackCheck?.pass).toBe(false);
  });

  it("passes ack rate within tolerance", () => {
    const metrics = {
      docs: 50,
      snapshotsPushed: 3043,
      acksReceived: 12000,
      ackRate: 394.3,
      ackLatencyP50: 102,
      ackLatencyP95: 2113,
      ackLatencyP99: 2888,
      errorCount: 0,
      readerSyncs: 14965,
      convergenceOk: 14965,
      convergenceDrift: 0,
      syncLatencyP50: 10,
      syncLatencyP95: 33,
      maxRecoveryMs: 0,
      churnCycles: 0,
      nodesJoined: 0,
      nodesLeft: 0,
    };
    // 394.3 >= 486.5 * 0.8 = 389.2 → pass
    const checks = compareBaseline(metrics, baseline, 20);
    const ackCheck = checks.find((c) => c.name === "Regression: ack rate");
    expect(ackCheck?.pass).toBe(true);
  });

  it("fails on latency p95 regression", () => {
    const metrics = {
      docs: 50,
      snapshotsPushed: 3043,
      acksReceived: 14805,
      ackRate: 486.5,
      ackLatencyP50: 102,
      ackLatencyP95: 3000,
      ackLatencyP99: 4000,
      errorCount: 0,
      readerSyncs: 14965,
      convergenceOk: 14965,
      convergenceDrift: 0,
      syncLatencyP50: 10,
      syncLatencyP95: 33,
      maxRecoveryMs: 0,
      churnCycles: 0,
      nodesJoined: 0,
      nodesLeft: 0,
    };
    // 3000 > 2113 * 1.2 = 2535.6 → fail
    const checks = compareBaseline(metrics, baseline, 20);
    const latCheck = checks.find((c) => c.name === "Regression: latency p95");
    expect(latCheck?.pass).toBe(false);
  });

  it("fails on new convergence drift", () => {
    const metrics = {
      docs: 50,
      snapshotsPushed: 3043,
      acksReceived: 14805,
      ackRate: 486.5,
      ackLatencyP50: 102,
      ackLatencyP95: 2113,
      ackLatencyP99: 2888,
      errorCount: 0,
      readerSyncs: 14965,
      convergenceOk: 14960,
      convergenceDrift: 5,
      syncLatencyP50: 10,
      syncLatencyP95: 33,
      maxRecoveryMs: 0,
      churnCycles: 0,
      nodesJoined: 0,
      nodesLeft: 0,
    };
    const checks = compareBaseline(metrics, baseline, 20);
    const convCheck = checks.find((c) => c.name === "Regression: convergence");
    expect(convCheck?.pass).toBe(false);
  });

  it("respects custom tolerance", () => {
    const metrics = {
      docs: 50,
      snapshotsPushed: 3043,
      acksReceived: 13000,
      ackRate: 427.2,
      ackLatencyP50: 102,
      ackLatencyP95: 2113,
      ackLatencyP99: 2888,
      errorCount: 0,
      readerSyncs: 14965,
      convergenceOk: 14965,
      convergenceDrift: 0,
      syncLatencyP50: 10,
      syncLatencyP95: 33,
      maxRecoveryMs: 0,
      churnCycles: 0,
      nodesJoined: 0,
      nodesLeft: 0,
    };
    // 427.2 < 486.5 * 0.9 = 437.85 → fail at 10%
    const strict = compareBaseline(metrics, baseline, 10);
    const ackStrict = strict.find((c) => c.name === "Regression: ack rate");
    expect(ackStrict?.pass).toBe(false);

    // 427.2 >= 486.5 * 0.8 = 389.2 → pass at 20%
    const lenient = compareBaseline(metrics, baseline, 20);
    const ackLenient = lenient.find((c) => c.name === "Regression: ack rate");
    expect(ackLenient?.pass).toBe(true);
  });
});

// --- Integration tests via CLI ---

describe("analyze --baseline (CLI)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regression-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  function makeEvents(ackRate: number, latencyP95: number) {
    const epoch = 1000000;
    const snaps = 100;
    const acks = Math.round((snaps * ackRate) / 100);
    const events: object[] = [];

    for (let i = 0; i < snaps; i++) {
      events.push({
        ts: epoch + i * 1000,
        type: "snapshot-pushed",
        docId: "d1",
        cid: `snap-${i}`,
      });
    }
    for (let i = 0; i < acks; i++) {
      events.push({
        ts: epoch + i * 1000 + latencyP95,
        type: "ack-received",
        docId: "d1",
        cid: `snap-${i}`,
      });
    }
    return events;
  }

  it("passes when metrics match baseline", () => {
    const events = makeEvents(500, 2000);
    const jsonl = join(dir, "test.jsonl");
    const baselineFile = join(dir, "baseline.json");

    writeFileSync(
      jsonl,
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    writeFileSync(
      baselineFile,
      JSON.stringify({
        version: 1,
        date: "2026-03-14",
        ackRate: 500,
        ackLatencyP50: 2000,
        ackLatencyP95: 2000,
        ackLatencyP99: 2000,
        snapshotsPushed: 100,
        acksReceived: 500,
        readerSyncs: 0,
        convergenceOk: 0,
        convergenceDrift: 0,
        syncLatencyP50: 0,
        syncLatencyP95: 0,
        errorCount: 0,
      }),
    );

    const result = execSync(
      `node dist/bin/analyze.js` +
        ` ${jsonl}` +
        ` --max-errors 999` +
        ` --ack-rate 50` +
        ` --baseline ${baselineFile}`,
      { encoding: "utf-8", timeout: 10000, cwd: pkgRoot },
    );

    expect(result).toContain("Regression Analysis");
    expect(result).toContain("[PASS] Regression: ack rate");
    expect(result).toContain("[PASS] Regression: latency p95");
    expect(result).toContain("\nPASS");
  });

  it("fails on ack rate regression", () => {
    // Current run: 200% ack rate
    // Baseline: 500% ack rate
    // 200 < 500 * 0.8 = 400 → fail
    const events = makeEvents(200, 2000);
    const jsonl = join(dir, "test.jsonl");
    const baselineFile = join(dir, "baseline.json");

    writeFileSync(
      jsonl,
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    writeFileSync(
      baselineFile,
      JSON.stringify({
        version: 1,
        date: "2026-03-14",
        ackRate: 500,
        ackLatencyP50: 2000,
        ackLatencyP95: 2000,
        ackLatencyP99: 2000,
        snapshotsPushed: 100,
        acksReceived: 500,
        readerSyncs: 0,
        convergenceOk: 0,
        convergenceDrift: 0,
        syncLatencyP50: 0,
        syncLatencyP95: 0,
        errorCount: 0,
      }),
    );

    try {
      execSync(
        `node dist/bin/analyze.js` +
          ` ${jsonl}` +
          ` --max-errors 999` +
          ` --ack-rate 50` +
          ` --baseline ${baselineFile}`,
        { encoding: "utf-8", timeout: 10000, cwd: pkgRoot },
      );
      expect.fail("should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { status: number; stdout: string };
      expect(e.status).toBe(1);
      expect(e.stdout).toContain("[FAIL] Regression: ack rate");
    }
  });

  it("saves baseline with --save-baseline", () => {
    const events = makeEvents(500, 2000);
    const jsonl = join(dir, "test.jsonl");
    const outBaseline = join(dir, "new-baseline.json");

    writeFileSync(
      jsonl,
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    execSync(
      `node dist/bin/analyze.js` +
        ` ${jsonl}` +
        ` --max-errors 999` +
        ` --ack-rate 50` +
        ` --save-baseline ${outBaseline}`,
      { encoding: "utf-8", timeout: 10000, cwd: pkgRoot },
    );

    const saved = JSON.parse(readFileSync(outBaseline, "utf-8"));
    expect(saved.version).toBe(1);
    expect(saved.ackRate).toBeGreaterThan(0);
    expect(saved.snapshotsPushed).toBe(100);
    expect(saved.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
