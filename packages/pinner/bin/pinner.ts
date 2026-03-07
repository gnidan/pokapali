#!/usr/bin/env node

import { createPinner } from "../src/pinner.js";

function usage(): never {
  console.error(
    "Usage: pokapali-pinner"
      + " --app-id <id> [--app-id <id> ...]"
      + " --storage <path>"
      + " [--max-per-hour <n>]"
      + " [--max-size <bytes>]"
      + " [--max-connections <n>]"
  );
  process.exit(1);
}

function parseArgs(args: string[]): {
  appIds: string[];
  storagePath: string;
  maxPerHour?: number;
  maxSizeBytes?: number;
  maxConnections?: number;
} {
  const appIds: string[] = [];
  let storagePath = "";
  let maxPerHour: number | undefined;
  let maxSizeBytes: number | undefined;
  let maxConnections: number | undefined;

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--app-id":
        if (!args[i + 1]) usage();
        appIds.push(args[++i]);
        break;
      case "--storage":
        if (!args[i + 1]) usage();
        storagePath = args[++i];
        break;
      case "--max-per-hour":
        if (!args[i + 1]) usage();
        maxPerHour = parseInt(args[++i], 10);
        break;
      case "--max-size":
        if (!args[i + 1]) usage();
        maxSizeBytes = parseInt(args[++i], 10);
        break;
      case "--max-connections":
        if (!args[i + 1]) usage();
        maxConnections = parseInt(args[++i], 10);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        usage();
    }
    i++;
  }

  if (appIds.length === 0 || !storagePath) usage();

  return {
    appIds,
    storagePath,
    maxPerHour,
    maxSizeBytes,
    maxConnections,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const pinner = await createPinner({
    appIds: args.appIds,
    storagePath: args.storagePath,
    maxConnections: args.maxConnections,
    rateLimits: {
      ...(args.maxPerHour !== undefined
        ? { maxSnapshotsPerHour: args.maxPerHour }
        : {}),
      ...(args.maxSizeBytes !== undefined
        ? { maxBlockSizeBytes: args.maxSizeBytes }
        : {}),
    },
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    await pinner.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await pinner.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
