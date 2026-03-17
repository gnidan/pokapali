/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Helia } from "helia";
import { createLogger } from "@pokapali/log";
import { LOG_INTERVAL_MS } from "./relay-utils.js";

const log = createLogger("relay");

/**
 * Periodic status logging with GossipSub mesh
 * diagnostics. Returns the interval handle.
 */
export function startStatusLogging(
  helia: Helia,
  pubsub: any,
): ReturnType<typeof setInterval> {
  let lastAddrCount = 0;

  return setInterval(() => {
    const conns = helia.libp2p.getConnections();
    const peers = helia.libp2p.getPeers();
    const ma = helia.libp2p.getMultiaddrs();
    const gsTopics = pubsub.getTopics();
    const gsPeers = (pubsub as any).getPeers?.() ?? [];
    const gsSubs = gsTopics.flatMap((t: string) =>
      pubsub
        .getSubscribers(t)
        .map((p: any) => `${t}:${p.toString().slice(-8)}`),
    );
    const meshInfo = gsTopics.map((t: string) => {
      const mp = pubsub.getMeshPeers?.(t);
      return mp ? `${t}:${mp.length}` : `${t}:?`;
    });
    log.debug(
      `${conns.length} conns,`,
      `${peers.length} peers,`,
      `gs: ${gsPeers.length} peers,`,
      `${gsSubs.length} subs,`,
      `topics: ${gsTopics},`,
      `mesh: ${meshInfo}`,
    );

    // Per-topic diagnostic: mesh status, score,
    // backoff for each subscriber
    const gs = pubsub as any;
    const backoffMap = gs.backoff as
      | Map<string, Map<string, number>>
      | undefined;
    const streamsOut = gs.streamsOutbound as Map<string, any> | undefined;
    for (const topic of gsTopics) {
      const subs = pubsub.getSubscribers(topic);
      if (subs.length === 0) continue;
      const topicMeshPeers = new Set(
        (pubsub.getMeshPeers?.(topic) ?? []).map((p: any) => p.toString()),
      );
      const topicBackoff = backoffMap?.get(topic);
      const details = subs.map((p: any) => {
        const id = p.toString();
        const short = id.slice(-8);
        const inMesh = topicMeshPeers.has(id) ? "M" : "-";
        const hasStream = streamsOut?.has(id) ? "S" : "!S";
        const score = gs.score?.score?.(id) ?? "?";
        const bo = topicBackoff?.has(id)
          ? `BO:${Math.round(
              ((topicBackoff.get(id) ?? 0) - Date.now()) / 1000,
            )}s`
          : "-";
        return (
          `${short}[${inMesh}${hasStream} ` +
          `sc:${typeof score === "number" ? score.toFixed(1) : score} ${bo}]`
        );
      });
      const shortTopic = topic.length > 30 ? "..." + topic.slice(-25) : topic;
      log.debug(`  ${shortTopic}: ${details.join(" ")}`);
    }

    if (ma.length !== lastAddrCount) {
      lastAddrCount = ma.length;
      for (const a of ma) {
        log.debug("  addr:", a.toString());
      }
    }
  }, LOG_INTERVAL_MS);
}
