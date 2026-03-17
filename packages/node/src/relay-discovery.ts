/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Helia } from "helia";
import type { CID } from "multiformats/cid";
import { createLogger } from "@pokapali/log";
import {
  RELAY_PEER_TAG,
  RELAY_PEER_TAG_VALUE,
  HEALTH_CHECK_MIN_MS,
  HEALTH_CHECK_MAX_MS,
} from "./relay-utils.js";

const log = createLogger("relay");

/**
 * Find other relays providing the network CID and
 * dial them. Tags peers to protect connections from
 * pruning. GossipSub mesh formation handles message
 * routing from there.
 */
export async function findAndDialProviders(
  helia: Helia,
  netCID: CID,
  knownRelayPeerIds: Set<string>,
): Promise<void> {
  const selfId = helia.libp2p.peerId.toString();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let found = 0;
    for await (const provider of helia.routing.findProviders(netCID, {
      signal: ctrl.signal,
    })) {
      found++;
      const pid = provider.id.toString();
      if (pid === selfId) continue;
      for (const ma of provider.multiaddrs) {
        try {
          await helia.libp2p.dial(ma, {
            signal: ctrl.signal,
          });
          log.info("dialed relay provider:" + ` ${ma.toString().slice(-20)}`);
          helia.libp2p.peerStore
            .merge(provider.id, {
              tags: {
                [RELAY_PEER_TAG]: {
                  value: RELAY_PEER_TAG_VALUE,
                },
              },
            })
            .catch((err) => {
              log.warn(
                "peerStore.merge failed for" + ` ...${pid.slice(-8)}:`,
                err,
              );
            });
          knownRelayPeerIds.add(pid);
          log.info(`tagged relay ...${pid.slice(-8)}`);
        } catch (err) {
          log.debug(
            "dial failed for provider" + ` ...${pid.slice(-8)}:`,
            (err as Error).message,
          );
        }
      }
    }
    clearTimeout(timer);
    log.debug(`findProviders found ${found} providers`);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.includes("abort")) {
      log.error(`findProviders failed: ${msg}`);
    }
  }
}

/**
 * Discover and dial existing providers, then provide
 * ourselves on the network CID.
 */
export async function provideAll(
  helia: Helia,
  netCID: CID,
  knownRelayPeerIds: Set<string>,
): Promise<void> {
  await findAndDialProviders(helia, netCID, knownRelayPeerIds);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    await helia.routing.provide(netCID, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    log.debug("provide OK for network CID");
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("abort")) {
      log.warn("provide TIMEOUT for network CID");
    } else {
      log.error(`provide FAIL for network CID: ${msg}`);
    }
  }
}

/**
 * Periodically verify connectivity to known relay
 * peers. Re-dial any that have silently dropped.
 * Jittered interval (60-90s) prevents thundering
 * herd across relays.
 */
export function scheduleHealthCheck(
  helia: Helia,
  netCID: CID,
  knownRelayPeerIds: Set<string>,
): { clear: () => void } {
  let timer: ReturnType<typeof setTimeout>;

  function schedule(): ReturnType<typeof setTimeout> {
    const jitter =
      HEALTH_CHECK_MIN_MS +
      Math.random() * (HEALTH_CHECK_MAX_MS - HEALTH_CHECK_MIN_MS);
    return setTimeout(async () => {
      const connectedPids = new Set(
        helia.libp2p.getConnections().map((c: any) => c.remotePeer.toString()),
      );
      for (const pid of knownRelayPeerIds) {
        if (connectedPids.has(pid)) continue;
        const short = pid.slice(-8);
        log.info(`health: relay ...${short} not connected,`, `re-dialing`);
        findAndDialProviders(helia, netCID, knownRelayPeerIds).catch((err) => {
          log.warn("health re-dial failed:", (err as Error)?.message ?? err);
        });
        break; // one re-dial pass per check
      }
      timer = schedule();
    }, jitter);
  }

  timer = schedule();
  return { clear: () => clearTimeout(timer) };
}
