import { useState, useEffect } from "react";
import { getHelia } from "@pokapali/core";
import type { CollabDoc } from "@pokapali/core";

interface RelayInfo {
  short: string;
  connected: boolean;
}

interface ConnectionInfo {
  ipfsPeers: number;
  relays: RelayInfo[];
  editors: number;
}

function gatherInfo(doc: CollabDoc): ConnectionInfo {
  let ipfsPeers = 0;
  const relays: RelayInfo[] = [];
  let editors = 1; // count self

  try {
    const helia = getHelia();
    const libp2p = (helia as any).libp2p;
    ipfsPeers = libp2p.getPeers().length;

    // Only show relays discovered for this app
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
          connected: connectedPids.has(pid),
        });
      }
    }
  } catch {
    // Helia not ready
  }

  try {
    const states = doc.awareness.getStates();
    editors = Math.max(1, states.size);
  } catch {
    // awareness not ready
  }

  return { ipfsPeers, relays, editors };
}

export function ConnectionStatus({
  doc,
}: {
  doc: CollabDoc;
}) {
  const [info, setInfo] = useState<ConnectionInfo>({
    ipfsPeers: 0,
    relays: [],
    editors: 1,
  });

  useEffect(() => {
    const poll = setInterval(() => {
      setInfo(gatherInfo(doc));
    }, 2000);
    setInfo(gatherInfo(doc));
    return () => clearInterval(poll);
  }, [doc]);

  const connectedRelays = info.relays.filter(
    (r) => r.connected,
  );

  return (
    <div className="connection-status">
      <span className="cs-section" title="libp2p peers">
        <span className="cs-label">IPFS</span>
        <span className="cs-value">
          {info.ipfsPeers}
        </span>
      </span>

      <span className="cs-divider" />

      <span
        className="cs-section"
        title={
          info.relays.length > 0
            ? info.relays
                .map(
                  (r) =>
                    `...${r.short}` +
                    (r.connected ? "" : " (offline)"),
                )
                .join(", ")
            : "No relays discovered yet"
        }
      >
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
              {connectedRelays.length}/{info.relays.length}
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
    </div>
  );
}
