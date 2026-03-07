import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;
const DISCOVERY_INTERVAL_MS = 15_000;
const PROVIDE_TIMEOUT_MS = 10_000;
const FIND_TIMEOUT_MS = 15_000;

const log = (...args: unknown[]) =>
  console.log("[pokapali:discovery]", ...args);

async function topicToCID(topic: string): Promise<CID> {
  const bytes = new TextEncoder().encode(topic);
  const hash = await sha256.digest(bytes);
  return CID.createV1(RAW_CODEC, hash);
}

function withTimeout(
  signal: AbortSignal,
  ms: number,
): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    ms,
  );
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    ctrl.abort();
  });
  return ctrl.signal;
}

export interface RoomDiscovery {
  stop(): void;
}

/**
 * Start DHT-based peer discovery for a set of room
 * topics. Provides our presence and searches for
 * other peers on the same topics in parallel.
 */
export function startRoomDiscovery(
  helia: Helia,
  roomTopics: string[],
): RoomDiscovery {
  let stopped = false;
  let cycleController: AbortController | null = null;

  const shortTopic = (t: string) =>
    t.replace("/pokapali/signal/", "");

  async function provideAll(
    signal: AbortSignal,
  ) {
    for (const topic of roomTopics) {
      if (signal.aborted) return;
      const s = shortTopic(topic);
      try {
        const cid = await topicToCID(topic);
        const sig = withTimeout(
          signal,
          PROVIDE_TIMEOUT_MS,
        );
        await helia.routing.provide(cid, {
          signal: sig,
        });
        log(`provide OK ${s}`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.includes("abort")) {
          log(`provide FAIL ${s}: ${msg}`);
        }
      }
    }
  }

  async function discoverAll(
    signal: AbortSignal,
  ) {
    for (const topic of roomTopics) {
      if (signal.aborted) return;
      const s = shortTopic(topic);
      try {
        const cid = await topicToCID(topic);
        const sig = withTimeout(
          signal,
          FIND_TIMEOUT_MS,
        );
        let found = 0;
        for await (const provider of
          helia.routing.findProviders(cid, {
            signal: sig,
          })
        ) {
          if (signal.aborted) return;
          found++;
          const pid = provider.id.toString();
          const short = pid.slice(-8);
          const already = helia.libp2p.getPeers()
            .some(p => p.toString() === pid);
          if (already) {
            log(`  provider ...${short} (connected)`);
            continue;
          }
          const addrs = provider.multiaddrs?.map(
            (ma: any) => ma.toString()
          ) ?? [];
          log(
            `  provider ...${short}, addrs:`,
            addrs.length ? addrs : "(none)",
          );
          log(`  dialing ...${short}...`);
          try {
            await helia.libp2p.dial(provider.id, {
              signal,
            });
            log(`  dialed ...${short} OK`);
          } catch (err) {
            log(
              `  dial ...${short} FAIL:`,
              (err as Error).message ?? err,
            );
          }
        }
        log(`findProviders ${s}: ${found} found`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.includes("abort")) {
          log(`findProviders FAIL ${s}: ${msg}`);
        }
      }
    }
  }

  async function cycle() {
    // Abort previous cycle if still running
    cycleController?.abort();
    cycleController = new AbortController();
    const signal = cycleController.signal;

    log(
      "cycle start,",
      `${helia.libp2p.getPeers().length} peers`,
    );

    // Run provide and discover in parallel
    await Promise.allSettled([
      provideAll(signal),
      discoverAll(signal),
    ]);

    if (!signal.aborted) {
      log(
        "cycle done,",
        `${helia.libp2p.getPeers().length} peers`,
      );
    }
  }

  // Initial cycle
  cycle();

  // Periodic re-discovery
  const interval = setInterval(() => {
    if (!stopped) {
      cycle();
    }
  }, DISCOVERY_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      cycleController?.abort();
      clearInterval(interval);
    },
  };
}
