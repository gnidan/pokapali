import type { Helia } from "helia";
import type { PubSub } from "@libp2p/interface";
import type { GossipSub } from "@chainsafe/libp2p-gossipsub";
import { createLogger } from "@pokapali/log";
import { LOG_INTERVAL_MS } from "./relay-utils.js";

const log = createLogger("relay");

/**
 * Periodic status logging with GossipSub mesh
 * diagnostics. Returns the interval handle.
 */
export function startStatusLogging(
  helia: Helia,
  pubsub: PubSub,
): ReturnType<typeof setInterval> {
  let lastAddrCount = 0;
  const gs = pubsub as GossipSub;

  return setInterval(() => {
    const conns = helia.libp2p.getConnections();
    const peers = helia.libp2p.getPeers();
    const ma = helia.libp2p.getMultiaddrs();
    const gsTopics = gs.getTopics();
    const gsPeers = gs.getPeers();
    const gsSubs = gsTopics.flatMap((t) =>
      gs.getSubscribers(t).map((p) => `${t}:${p.toString().slice(-8)}`),
    );
    const meshInfo = gsTopics.map((t) => {
      const mp = gs.getMeshPeers(t);
      return `${t}:${mp.length}`;
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
    // backoff for each subscriber.
    // These access GossipSub internal properties
    // that have no public API.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gsInternal = gs as any;
    const backoffMap = gsInternal.backoff as
      | Map<string, Map<string, number>>
      | undefined;
    const streamsOut = gsInternal.streamsOutbound as
      | Map<string, unknown>
      | undefined;
    for (const topic of gsTopics) {
      const subs = gs.getSubscribers(topic);
      if (subs.length === 0) continue;
      const topicMeshPeers = new Set(gs.getMeshPeers(topic));
      const topicBackoff = backoffMap?.get(topic);
      const details = subs.map((p) => {
        const id = p.toString();
        const short = id.slice(-8);
        const inMesh = topicMeshPeers.has(id) ? "M" : "-";
        const hasStream = streamsOut?.has(id) ? "S" : "!S";
        const score = gsInternal.score?.score?.(id) ?? "?";
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
