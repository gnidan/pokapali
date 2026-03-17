import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("analyze --phase", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "analyze-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("computes per-phase ack rates", () => {
    const epoch = 1000000;
    // Baseline (0-10s): 5 snaps, 5 acks = 100%
    // Degraded (10-20s): 5 snaps, 2 acks = 40%
    const events = [
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: epoch + i * 1000,
        type: "snapshot-pushed",
        docId: "d1",
        cid: `base-${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: epoch + i * 1000 + 500,
        type: "ack-received",
        docId: "d1",
        cid: `base-${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: epoch + 10000 + i * 1000,
        type: "snapshot-pushed",
        docId: "d1",
        cid: `deg-${i}`,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        ts: epoch + 10000 + i * 1000 + 500,
        type: "ack-received",
        docId: "d1",
        cid: `deg-${i}`,
      })),
    ];

    const file = join(dir, "test.jsonl");
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = execSync(
      `node dist/bin/analyze.js ${file}` +
        ` --max-errors 999` +
        ` --ack-rate 50` +
        ` --phase baseline:0:10` +
        ` --phase degraded:10:20` +
        ` --phase-ack-rate baseline:90` +
        ` --phase-ack-rate degraded:30`,
      { encoding: "utf-8", timeout: 10000, cwd: pkgRoot },
    );

    expect(result).toContain("baseline:");
    expect(result).toContain("100.0% ack rate");
    expect(result).toContain("degraded:");
    expect(result).toContain("40.0% ack rate");
    expect(result).toContain("PASS");
  });

  it("fails when phase ack rate below threshold", () => {
    const epoch = 1000000;
    const events = [
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: epoch + i * 1000,
        type: "snapshot-pushed",
        docId: "d1",
        cid: `snap-${i}`,
      })),
    ];

    const file = join(dir, "test.jsonl");
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    try {
      execSync(
        `node dist/bin/analyze.js ${file}` +
          ` --max-errors 999` +
          ` --phase degraded:0:10` +
          ` --phase-ack-rate degraded:50`,
        { encoding: "utf-8", timeout: 10000, cwd: pkgRoot },
      );
      expect.fail("should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { status: number; stdout: string };
      expect(e.status).toBe(1);
      expect(e.stdout).toContain("FAIL");
    }
  });
});
