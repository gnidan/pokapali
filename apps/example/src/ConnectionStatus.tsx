import { useState, useEffect } from "react";
import type {
  CollabDoc,
  DiagnosticsInfo,
} from "@pokapali/core";

function RelayDot({ connected }: {
  connected: boolean;
}) {
  return (
    <span
      className={
        "cs-dot " +
        (connected ? "connected" : "disconnected")
      }
      aria-hidden="true"
    />
  );
}

export function ConnectionStatus({
  doc,
}: {
  doc: CollabDoc;
}) {
  const [info, setInfo] = useState<DiagnosticsInfo>(
    () => doc.diagnostics(),
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active) return;
      try {
        setInfo(doc.diagnostics());
      } catch {
        // doc destroyed during teardown — awareness
        // disconnect fires before listener removal
      }
    };
    refresh();

    // Immediate updates on doc and awareness events
    doc.on("status", refresh);
    doc.on("snapshot-recommended", refresh);
    doc.on("snapshot-applied", refresh);
    doc.on("ack", refresh);
    doc.on("fetch-state", refresh);
    const awareness = doc.awareness;
    awareness.on("change", refresh);

    // Slow poll as fallback for libp2p peer counts
    // (no event for peer connect/disconnect)
    const poll = setInterval(
      refresh,
      expanded ? 2000 : 10_000,
    );

    return () => {
      active = false;
      doc.off("status", refresh);
      doc.off("snapshot-recommended", refresh);
      doc.off("snapshot-applied", refresh);
      doc.off("ack", refresh);
      doc.off("fetch-state", refresh);
      awareness.off("change", refresh);
      clearInterval(poll);
    };
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
        aria-expanded={expanded}
        aria-label={
          `Connection status: ` +
          `${info.ipfsPeers} IPFS peers, ` +
          `${connectedRelays.length} of ` +
          `${info.relays.length} relays, ` +
          `${info.editors} editor(s)`
        }
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
                <span className="cs-dot inactive" aria-hidden="true" />
                0
              </>
            ) : connectedRelays.length ===
              info.relays.length ? (
              <>
                <span className="cs-dot connected" aria-hidden="true" />
                {info.relays.length}
              </>
            ) : connectedRelays.length > 0 ? (
              <>
                <span className="cs-dot partial" aria-hidden="true" />
                {connectedRelays.length}/
                {info.relays.length}
              </>
            ) : (
              <>
                <span className="cs-dot disconnected" aria-hidden="true" />
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
                <span className="cs-dot connected" aria-hidden="true" />
                {info.editors}
              </>
            ) : (
              <>
                <span className="cs-dot inactive" aria-hidden="true" />
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
          // "Loading" covers IPNS resolution, block
          // fetch, and retries — the user doesn't need
          // to know the internal fetch lifecycle.
          const isLoading =
            !info.hasAppliedSnapshot &&
            fs.status !== "failed" &&
            fs.status !== "idle";
          const isFailed = fs.status === "failed";

          if (
            behind <= 0 &&
            !isFailed &&
            !isLoading
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
                {isLoading
                  ? "Loading\u2026"
                  : isFailed
                    ? "Load failed"
                    : `~${behind} edits behind`
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
            {info.ackedBy.length > 0 && (
              <div className="cs-detail-row">
                <span className="cs-detail-key">
                  Acked by
                </span>
                <span className="cs-detail-mono">
                  {info.ackedBy.length} relay(s)
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
