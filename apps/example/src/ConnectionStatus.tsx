import { useState, useEffect, useRef } from "react";
import type {
  CollabDoc,
  DiagnosticsInfo,
  SnapshotFetchState,
} from "@pokapali/core";

// --- Ring buffer for sparkline history ---

const MAX_SAMPLES = 60;

interface History {
  peers: number[];
  relays: number[];
  clockSum: number[];
}

function emptyHistory(): History {
  return { peers: [], relays: [], clockSum: [] };
}

function pushSample(
  h: History,
  info: DiagnosticsInfo,
) {
  const connectedRelays = info.relays.filter(
    (r) => r.connected,
  ).length;
  h.peers.push(info.ipfsPeers);
  h.relays.push(connectedRelays);
  h.clockSum.push(info.clockSum);
  if (h.peers.length > MAX_SAMPLES) h.peers.shift();
  if (h.relays.length > MAX_SAMPLES) {
    h.relays.shift();
  }
  if (h.clockSum.length > MAX_SAMPLES) {
    h.clockSum.shift();
  }
}

// --- SVG Sparkline ---

function Sparkline({
  data,
  color,
  width = 100,
  height = 28,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;

  const pad = 1;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x =
      (i / (data.length - 1)) * (width - 2 * pad) +
      pad;
    const y =
      height -
      pad -
      ((v - min) / range) * (height - 2 * pad);
    return `${x},${y}`;
  });

  const line = points.join(" ");
  // Fill area: close path along bottom edge
  const fill =
    line +
    ` ${width - pad},${height} ${pad},${height}`;

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <polygon
        points={fill}
        fill={color}
        fillOpacity="0.1"
      />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Current value dot */}
      <circle
        cx={points[points.length - 1].split(",")[0]}
        cy={points[points.length - 1].split(",")[1]}
        r="2"
        fill={color}
      />
    </svg>
  );
}

// --- Helpers ---

function Dot({ state }: {
  state: "connected" | "disconnected" | "partial"
    | "inactive";
}) {
  return (
    <span
      className={`cs-dot ${state}`}
      aria-hidden="true"
    />
  );
}

function relayDotState(
  connected: number,
  total: number,
): "connected" | "disconnected" | "partial"
  | "inactive" {
  if (total === 0) return "inactive";
  if (connected === total) return "connected";
  if (connected > 0) return "partial";
  return "disconnected";
}

function fetchLabel(fs: SnapshotFetchState): string {
  switch (fs.status) {
    case "idle": return "Idle";
    case "resolving": return "Resolving IPNS\u2026";
    case "fetching":
      return `Fetching ...${fs.cid.slice(-8)}`;
    case "retrying": {
      const wait = Math.max(
        0,
        Math.round(
          (fs.nextRetryAt - Date.now()) / 1000,
        ),
      );
      return `Retry #${fs.attempt} in ${wait}s`;
    }
    case "failed":
      return `Failed: ${fs.error}`;
  }
}

// --- Summary bar sections ---

function PeersSummary({
  info,
}: {
  info: DiagnosticsInfo;
}) {
  return (
    <span
      className="cs-section"
      title="libp2p peers"
    >
      <span className="cs-label">Peers</span>
      <span className="cs-value">
        {info.ipfsPeers}
      </span>
    </span>
  );
}

function RelaysSummary({
  info,
}: {
  info: DiagnosticsInfo;
}) {
  const connected = info.relays.filter(
    (r) => r.connected,
  ).length;
  const total = info.relays.length;
  return (
    <span className="cs-section">
      <span className="cs-label">Relays</span>
      <span className="cs-value">
        <Dot state={relayDotState(connected, total)} />
        {total === 0
          ? "0"
          : connected === total
            ? String(total)
            : `${connected}/${total}`}
      </span>
    </span>
  );
}

function UsersSummary({
  info,
}: {
  info: DiagnosticsInfo;
}) {
  return (
    <span
      className="cs-section"
      title="Awareness peers"
    >
      <span className="cs-label">Users</span>
      <span className="cs-value">
        <Dot
          state={
            info.editors > 1
              ? "connected"
              : "inactive"
          }
        />
        {info.editors}
      </span>
    </span>
  );
}

function SyncSummary({
  info,
}: {
  info: DiagnosticsInfo;
}) {
  const behind = Math.max(
    info.maxPeerClockSum,
    info.latestAnnouncedSeq,
  ) - info.clockSum;
  const fs = info.fetchState;
  const isLoading =
    !info.hasAppliedSnapshot &&
    fs.status !== "failed" &&
    fs.status !== "idle";
  const isFailed = fs.status === "failed";

  if (behind <= 0 && !isFailed && !isLoading) {
    return null;
  }

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
          `announced: ${info.latestAnnouncedSeq}`
        }
      >
        {isLoading
          ? "Loading\u2026"
          : isFailed
            ? "Load failed"
            : `~${behind} edits behind`}
      </span>
    </>
  );
}

// --- Expanded detail sections ---

function PeersDetail({
  info,
  history,
}: {
  info: DiagnosticsInfo;
  history: History;
}) {
  return (
    <div className="cs-detail-section">
      <div className="cs-detail-heading">Peers</div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">
          Awareness
        </span>
        {info.editors}
      </div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">
          libp2p
        </span>
        {info.ipfsPeers}
      </div>
      <Sparkline
        data={history.peers}
        color="#2563eb"
      />
    </div>
  );
}

function RelaysDetail({
  info,
  history,
}: {
  info: DiagnosticsInfo;
  history: History;
}) {
  return (
    <div className="cs-detail-section">
      <div className="cs-detail-heading">Relays</div>
      {info.relays.length === 0 ? (
        <div className="cs-detail-row cs-detail-dim">
          No relays discovered
        </div>
      ) : (
        info.relays.map((r) => (
          <div
            key={r.peerId}
            className="cs-detail-row"
          >
            <Dot
              state={
                r.connected
                  ? "connected"
                  : "disconnected"
              }
            />
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
      <Sparkline
        data={history.relays}
        color="#22c55e"
      />
    </div>
  );
}

function GossipSubDetail({
  info,
}: {
  info: DiagnosticsInfo;
}) {
  const gs = info.gossipsub;
  return (
    <div className="cs-detail-section">
      <div className="cs-detail-heading">
        GossipSub
      </div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">
          Peers
        </span>
        {gs.peers}
      </div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">
          Mesh
        </span>
        {gs.meshPeers}
      </div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">
          Topics
        </span>
        {gs.topics}
      </div>
    </div>
  );
}

function SnapshotsDetail({
  info,
  history,
}: {
  info: DiagnosticsInfo;
  history: History;
}) {
  return (
    <div className="cs-detail-section">
      <div className="cs-detail-heading">
        Snapshots
      </div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">
          Clock
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
      <div className="cs-detail-row">
        <span className="cs-detail-key">
          Fetch
        </span>
        <span
          className={
            info.fetchState.status === "failed"
              ? "cs-detail-warn"
              : ""
          }
        >
          {fetchLabel(info.fetchState)}
        </span>
      </div>
      {info.ackedBy.length > 0 && (
        <div className="cs-detail-row">
          <span className="cs-detail-key">
            Acked
          </span>
          <span className="cs-detail-mono">
            {info.ackedBy.length} pinner(s)
          </span>
        </div>
      )}
      <Sparkline
        data={history.clockSum}
        color="#8b5cf6"
      />
    </div>
  );
}

// --- Main component ---

export function ConnectionStatus({
  doc,
}: {
  doc: CollabDoc;
}) {
  const [info, setInfo] = useState<DiagnosticsInfo>(
    () => doc.diagnostics(),
  );
  const [expanded, setExpanded] = useState(false);
  const historyRef = useRef<History>(emptyHistory());

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active) return;
      try {
        const d = doc.diagnostics();
        pushSample(historyRef.current, d);
        setInfo(d);
      } catch {
        // doc destroyed during teardown
      }
    };
    refresh();

    doc.on("status", refresh);
    doc.on("snapshot-recommended", refresh);
    doc.on("snapshot-applied", refresh);
    doc.on("ack", refresh);
    doc.on("fetch-state", refresh);
    const awareness = doc.awareness;
    awareness.on("change", refresh);

    // Fallback poll for libp2p peer counts
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

  const connected = info.relays.filter(
    (r) => r.connected,
  ).length;
  const h = historyRef.current;

  return (
    <div className="connection-status-wrap">
      <button
        className="connection-status"
        onClick={() => setExpanded((e) => !e)}
        title="Click for diagnostics"
        aria-expanded={expanded}
        aria-label={
          `${info.ipfsPeers} peers, ` +
          `${connected}/${info.relays.length} ` +
          `relays, ${info.editors} user(s)`
        }
      >
        <PeersSummary info={info} />
        <span className="cs-divider" />
        <RelaysSummary info={info} />
        <span className="cs-divider" />
        <UsersSummary info={info} />
        <SyncSummary info={info} />
        <span className="cs-expand">
          {expanded ? "\u25B4" : "\u25BE"}
        </span>
      </button>

      {expanded && (
        <div className="cs-detail">
          <PeersDetail info={info} history={h} />
          <GossipSubDetail info={info} />
          <RelaysDetail info={info} history={h} />
          <SnapshotsDetail info={info} history={h} />
        </div>
      )}
    </div>
  );
}
