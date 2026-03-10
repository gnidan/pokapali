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
}

export function createMetrics(
  outputPath?: string,
): MetricsCollector {
  const startedAt = Date.now();
  let peakRss = 0;

  const docs = new Set<string>();
  let snapshotsPushed = 0;
  let acksReceived = 0;
  const ackLatencies: number[] = [];
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
    },
  };
}
