import { useState, useEffect } from "react";
import { getHelia } from "@pokapali/core";
import type {
  CollabDoc,
  SnapshotFetchState,
} from "@pokapali/core";

interface RelayInfo {
  short: string;
  peerId: string;
  connected: boolean;
}

interface GossipSubInfo {
  peers: number;
  topics: number;
  meshPeers: number;
}

interface ConnectionInfo {
  ipfsPeers: number;
  relays: RelayInfo[];
  editors: number;
  gossipsub: GossipSubInfo;
  clockSum: number;
  maxPeerClockSum: number;
  latestAnnouncedSeq: number;
  fetchState: SnapshotFetchState;
  ipnsSeq: number | null;
}

function gatherInfo(doc: CollabDoc): ConnectionInfo {
  let ipfsPeers = 0;
  const relays: RelayInfo[] = [];
  let editors = 1;
  let gossipsub: GossipSubInfo = {
    peers: 0,
    topics: 0,
    meshPeers: 0,
  };

  try {
    const helia = getHelia();
    const libp2p = (helia as any).libp2p;
    ipfsPeers = libp2p.getPeers().length;

    const knownRelays = doc.relayPeerIds;
    if (knownRelays.size > 0) {
      const connectedPids = new Set<string>();
      for (const conn of libp2p.getConnections()) {
        connectedPids.add(
          (conn as any).remotePeer.toString(),
        );
      }
      for (const pid of knownRelays) {
        relays.push({
          short: pid.slice(-8),
          peerId: pid,
          connected: connectedPids.has(pid),
        });
      }
    }

    // GossipSub info
    try {
      const pubsub = libp2p.services.pubsub;
      const topics: string[] =
        pubsub.getTopics?.() ?? [];
      const gsPeers = pubsub.getPeers?.() ?? [];
      const mesh = (pubsub as any).mesh as
        | Map<string, Set<string>>
        | undefined;
      let meshPeers = 0;
      if (mesh) {
        for (const set of mesh.values()) {
          meshPeers += set.size;
        }
      }
      gossipsub = {
        peers: gsPeers.length,
        topics: topics.length,
        meshPeers,
      };
    } catch {}
  } catch {
    // Helia not ready
  }

  let maxPeerClockSum = 0;
  try {
    const states = doc.awareness.getStates();
    editors = Math.max(1, states.size);
    for (const [, state] of states) {
      const cs = (state as any)?.clockSum;
      if (typeof cs === "number" && cs > maxPeerClockSum) {
        maxPeerClockSum = cs;
      }
    }
  } catch {}

  return {
    ipfsPeers,
    relays,
    editors,
    gossipsub,
    clockSum: doc.clockSum,
    maxPeerClockSum,
    latestAnnouncedSeq: doc.latestAnnouncedSeq,
    fetchState: doc.snapshotFetchState,
    ipnsSeq: doc.ipnsSeq,
  };
}

function RelayDot({ connected }: {
  connected: boolean;
}) {
  return (
    <span
      className={
        "cs-dot " +
        (connected ? "connected" : "disconnected")
      }
    />
  );
}

export function ConnectionStatus({
  doc,
}: {
  doc: CollabDoc;
}) {
  const [info, setInfo] = useState<ConnectionInfo>(
    () => ({
      ipfsPeers: 0,
      relays: [],
      editors: 1,
      gossipsub: { peers: 0, topics: 0, meshPeers: 0 },
      clockSum: doc.clockSum,
      maxPeerClockSum: 0,
      latestAnnouncedSeq: 0,
      fetchState: { status: "idle" },
      ipnsSeq: doc.ipnsSeq,
    }),
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setInfo(gatherInfo(doc));
    // Faster poll when expanded, slower when collapsed
    const interval = expanded ? 2000 : 5000;
    const poll = setInterval(
      () => setInfo(gatherInfo(doc)),
      interval,
    );
    return () => clearInterval(poll);
  }, [doc, expanded]);

  const connectedRelays = info.relays.filter(
    (r) => r.connected,
  );

  return (
    <div className="connection-status-wrap">
      <button
        className="connection-status"
        onClick={() => setExpanded((e) => !e)}
        title="Click for diagnostics"
      >
        <span
          className="cs-section"
          title="libp2p peers"
        >
          <span className="cs-label">IPFS</span>
          <span className="cs-value">
            {info.ipfsPeers}
          </span>
        </span>

        <span className="cs-divider" />

        <span className="cs-section">
          <span className="cs-label">Relays</span>
          <span className="cs-value">
            {info.relays.length === 0 ? (
              <>
                <span className="cs-dot inactive" />
                0
              </>
            ) : connectedRelays.length ===
              info.relays.length ? (
              <>
                <span className="cs-dot connected" />
                {info.relays.length}
              </>
            ) : connectedRelays.length > 0 ? (
              <>
                <span className="cs-dot partial" />
                {connectedRelays.length}/
                {info.relays.length}
              </>
            ) : (
              <>
                <span className="cs-dot disconnected" />
                0/{info.relays.length}
              </>
            )}
          </span>
        </span>

        <span className="cs-divider" />

        <span
          className="cs-section"
          title="Editors on this document"
        >
          <span className="cs-label">Editors</span>
          <span className="cs-value">
            {info.editors > 1 ? (
              <>
                <span className="cs-dot connected" />
                {info.editors}
              </>
            ) : (
              <>
                <span className="cs-dot inactive" />
                1
              </>
            )}
          </span>
        </span>

        {(() => {
          const behind = Math.max(
            info.maxPeerClockSum,
            info.latestAnnouncedSeq,
          ) - info.clockSum;
          const fs = info.fetchState;
          const fetchHint =
            fs.status === "resolving"
              ? "Resolving document\u2026"
              : fs.status === "fetching"
                ? " \u2014 fetching\u2026"
                : fs.status === "retrying"
                  ? ` \u2014 retrying (attempt ${fs.attempt})\u2026`
                  : fs.status === "failed"
                    ? " \u2014 fetch failed"
                    : "";
          const isFailed = fs.status === "failed";
          const isResolving =
            fs.status === "resolving";

          if (
            behind <= 0 &&
            !isFailed &&
            !isResolving
          ) return null;

          return (
            <>
              <span className="cs-divider" />
              <span
                className={
                  "cs-section " +
                  (isFailed
                    ? "cs-fetch-failed"
                    : "cs-behind")
                }
                title={
                  `Local: ${info.clockSum}, ` +
                  `peers: ${info.maxPeerClockSum}, ` +
                  `announced: ` +
                  `${info.latestAnnouncedSeq}`
                }
              >
                {isResolving
                  ? fetchHint
                  : <>
                      {behind > 0 && (
                        <>~{behind} edits behind</>
                      )}
                      {fetchHint}
                    </>
                }
              </span>
            </>
          );
        })()}

        <span className="cs-expand">
          {expanded ? "\u25B4" : "\u25BE"}
        </span>
      </button>

      {expanded && (
        <div className="cs-detail">
          {/* Relays */}
          <div className="cs-detail-section">
            <div className="cs-detail-heading">
              Relays
            </div>
            {info.relays.length === 0 ? (
              <div className="cs-detail-row">
                No relays discovered
              </div>
            ) : (
              info.relays.map((r) => (
                <div
                  key={r.peerId}
                  className="cs-detail-row"
                >
                  <RelayDot connected={r.connected} />
                  <span className="cs-detail-mono">
                    ...{r.short}
                  </span>
                  <span className="cs-detail-dim">
                    {r.connected
                      ? "connected"
                      : "disconnected"}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* GossipSub */}
          <div className="cs-detail-section">
            <div className="cs-detail-heading">
              GossipSub
            </div>
            <div className="cs-detail-row">
              <span className="cs-detail-key">
                Peers
              </span>
              {info.gossipsub.peers}
            </div>
            <div className="cs-detail-row">
              <span className="cs-detail-key">
                Topics
              </span>
              {info.gossipsub.topics}
            </div>
            <div className="cs-detail-row">
              <span className="cs-detail-key">
                Mesh peers
              </span>
              {info.gossipsub.meshPeers}
            </div>
          </div>

          {/* Doc sync */}
          <div className="cs-detail-section">
            <div className="cs-detail-heading">
              Document
            </div>
            <div className="cs-detail-row">
              <span className="cs-detail-key">
                Clock sum
              </span>
              <span className="cs-detail-mono">
                {info.clockSum}
              </span>
            </div>
            <div className="cs-detail-row">
              <span className="cs-detail-key">
                IPNS seq
              </span>
              <span className="cs-detail-mono">
                {info.ipnsSeq ?? "\u2014"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
