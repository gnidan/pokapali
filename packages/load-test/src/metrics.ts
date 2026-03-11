import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";

export interface LoadTestEvent {
  ts: number;
  type:
    | "snapshot-pushed"
    | "ack-received"
    | "status-change"
    | "error"
    | "doc-created"
    | "doc-ready";
  docId: string;
  latencyMs?: number;
  detail?: string;
  cid?: string;
  /** ms epoch until pinner re-announces. */
  guaranteeUntil?: number;
  /** ms epoch until pinner retains blocks. */
  retainUntil?: number;
}

export interface MetricsCollector {
  record(event: LoadTestEvent): void;
  /** Flush and print summary. Call on exit. */
  finish(): void;
}

interface Summary {
  totalDocs: number;
  snapshotsPushed: number;
  acksReceived: number;
  ackPercent: number;
  ackLatencyP50: number;
  ackLatencyP95: number;
  ackLatencyP99: number;
  durationS: number;
  memoryPeakMB: number;
  /** Number of acks that included guaranteeUntil. */
  acksWithGuarantee: number;
  /** Shortest guarantee window (days), if any. */
  guaranteeMinDays: number | null;
  /** Longest guarantee window (days), if any. */
  guaranteeMaxDays: number | null;
  /** Shortest retain window (days), if any. */
  retainMinDays: number | null;
  /** Longest retain window (days), if any. */
  retainMaxDays: number | null;
}

export function createMetrics(
  outputPath?: string,
): MetricsCollector {
  const startedAt = Date.now();
  let peakRss = 0;

  const docs = new Set<string>();
  let snapshotsPushed = 0;
  let acksReceived = 0;
  let acksWithGuarantee = 0;
  const ackLatencies: number[] = [];
  // Guarantee/retain window durations in ms
  const guaranteeWindows: number[] = [];
  const retainWindows: number[] = [];
  // CID → timestamp of snapshot-pushed, for ack latency
  const pendingSnapshots = new Map<string, number>();

  let stream: WriteStream | null = null;
  if (outputPath) {
    stream = createWriteStream(outputPath, {
      flags: "w",
    });
  }

  function trackMemory(): void {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }

  return {
    record(event: LoadTestEvent): void {
      trackMemory();

      // Write JSONL
      const line = JSON.stringify(event) + "\n";
      if (stream) {
        stream.write(line);
      } else {
        process.stdout.write(line);
      }

      // Accumulate stats
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
            const pushTs =
              pendingSnapshots.get(event.cid);
            if (pushTs != null) {
              ackLatencies.push(event.ts - pushTs);
              // Only measure first ack per CID
              pendingSnapshots.delete(event.cid);
            }
          }
          if (event.guaranteeUntil != null) {
            acksWithGuarantee++;
            guaranteeWindows.push(
              event.guaranteeUntil - event.ts,
            );
          }
          if (event.retainUntil != null) {
            retainWindows.push(
              event.retainUntil - event.ts,
            );
          }
          break;
      }
    },

    finish(): void {
      trackMemory();
      if (stream) {
        stream.end();
      }

      const sorted = ackLatencies
        .slice()
        .sort((a, b) => a - b);
      const p = (pct: number): number => {
        if (sorted.length === 0) return 0;
        const idx = Math.min(
          Math.floor(sorted.length * pct),
          sorted.length - 1,
        );
        return sorted[idx];
      };

      const MS_PER_DAY = 86_400_000;
      const minMax = (arr: number[]) =>
        arr.length > 0
          ? {
            min: Math.min(...arr) / MS_PER_DAY,
            max: Math.max(...arr) / MS_PER_DAY,
          }
          : null;
      const gw = minMax(guaranteeWindows);
      const rw = minMax(retainWindows);

      const durationS = (Date.now() - startedAt) / 1000;
      const summary: Summary = {
        totalDocs: docs.size,
        snapshotsPushed,
        acksReceived,
        ackPercent: snapshotsPushed > 0
          ? Math.round(
            (acksReceived / snapshotsPushed)
              * 100,
          )
          : 0,
        ackLatencyP50: p(0.5),
        ackLatencyP95: p(0.95),
        ackLatencyP99: p(0.99),
        durationS: Math.round(durationS),
        memoryPeakMB: Math.round(
          peakRss / 1024 / 1024,
        ),
        acksWithGuarantee,
        guaranteeMinDays: gw?.min ?? null,
        guaranteeMaxDays: gw?.max ?? null,
        retainMinDays: rw?.min ?? null,
        retainMaxDays: rw?.max ?? null,
      };

      console.error("\n--- Load Test Summary ---");
      console.error(
        `  Docs:       ${summary.totalDocs}`,
      );
      console.error(
        `  Snapshots:  ${summary.snapshotsPushed}`,
      );
      console.error(
        `  Acks:       ${summary.acksReceived}`
        + ` (${summary.ackPercent}%)`,
      );
      console.error(
        `  Ack p50:    ${summary.ackLatencyP50}ms`,
      );
      console.error(
        `  Ack p95:    ${summary.ackLatencyP95}ms`,
      );
      console.error(
        `  Ack p99:    ${summary.ackLatencyP99}ms`,
      );
      console.error(
        `  Duration:   ${summary.durationS}s`,
      );
      console.error(
        `  Peak RSS:   ${summary.memoryPeakMB}MB`,
      );
      if (summary.acksWithGuarantee > 0) {
        console.error(
          `  Guarantees: ${summary.acksWithGuarantee}`
          + ` acks with guarantee fields`,
        );
        if (
          summary.guaranteeMinDays != null
          && summary.guaranteeMaxDays != null
        ) {
          console.error(
            `  Guarantee:  `
            + `${summary.guaranteeMinDays.toFixed(1)}`
            + `-${summary.guaranteeMaxDays.toFixed(1)}d`,
          );
        }
        if (
          summary.retainMinDays != null
          && summary.retainMaxDays != null
        ) {
          console.error(
            `  Retain:     `
            + `${summary.retainMinDays.toFixed(1)}`
            + `-${summary.retainMaxDays.toFixed(1)}d`,
          );
        }
      } else {
        console.error(
          "  Guarantees: none"
          + " (pinners not sending guarantee fields)",
        );
      }
    },
  };
}
