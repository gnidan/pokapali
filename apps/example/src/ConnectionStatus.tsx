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
  mesh: number[];
  relays: number[];
  clockSum: number[];
}

function emptyHistory(): History {
  return {
    peers: [],
    mesh: [],
    relays: [],
    clockSum: [],
  };
}

function pushSample(
  h: History,
  info: DiagnosticsInfo,
) {
  h.peers.push(info.ipfsPeers);
  h.mesh.push(info.gossipsub.meshPeers);
  h.relays.push(
    info.relays.filter((r) => r.connected).length,
  );
  h.clockSum.push(info.clockSum);
  for (const key of Object.keys(h) as Array<
    keyof History
  >) {
    if (h[key].length > MAX_SAMPLES) h[key].shift();
  }
}

// --- SVG Sparkline ---

interface Series {
  data: number[];
  color: string;
  label: string;
}

function normalizePoints(
  data: number[],
  width: number,
  height: number,
  pad: number,
): string[] {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  return data.map((v, i) => {
    const x =
      (i / (data.length - 1)) *
        (width - 2 * pad) +
      pad;
    const y =
      height -
      pad -
      ((v - min) / range) * (height - 2 * pad);
    return `${x},${y}`;
  });
}

const SPARK_W = 300;
const SPARK_H = 40;
const SPARK_PAD = 2;

function Sparkline({
  data,
  color,
}: {
  data: number[];
  color: string;
}) {
  if (data.length < 2) return null;
  const pts = normalizePoints(
    data,
    SPARK_W,
    SPARK_H,
    SPARK_PAD,
  );
  const line = pts.join(" ");
  const fill =
    line +
    ` ${SPARK_W - SPARK_PAD},${SPARK_H}` +
    ` ${SPARK_PAD},${SPARK_H}`;
  const last = pts[pts.length - 1].split(",");

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <polygon
        points={fill}
        fill={color}
        fillOpacity="0.08"
      />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle
        cx={last[0]}
        cy={last[1]}
        r="2.5"
        fill={color}
      />
    </svg>
  );
}

function MultiSparkline({
  series,
}: {
  series: Series[];
}) {
  const active = series.filter(
    (s) => s.data.length >= 2,
  );
  if (active.length === 0) return null;

  return (
    <div className="sparkline-wrap">
      <svg
        className="sparkline"
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        {active.map((s) => {
          const pts = normalizePoints(
            s.data,
            SPARK_W,
            SPARK_H,
            SPARK_PAD,
          );
          const line = pts.join(" ");
          const last =
            pts[pts.length - 1].split(",");
          return (
            <g key={s.label}>
              <polyline
                points={line}
                fill="none"
                stroke={s.color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeOpacity="0.8"
              />
              <circle
                cx={last[0]}
                cy={last[1]}
                r="2.5"
                fill={s.color}
              />
            </g>
          );
        })}
      </svg>
      <div className="sparkline-legend">
        {active.map((s) => (
          <span key={s.label} className="legend-item">
            <span
              className="legend-swatch"
              style={{ background: s.color }}
            />
            <span className="legend-label">
              {s.label}
              {" "}
              {s.data[s.data.length - 1]}
            </span>
          </span>
        ))}
      </div>
    </div>
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

// --- Summary bar helpers ---

type Health = "connected" | "partial" | "disconnected"
  | "inactive";

function relayHealth(connected: number): Health {
  if (connected >= 3) return "connected";
  if (connected > 0) return "partial";
  return "disconnected";
}

function networkHealth(
  ipfsPeers: number,
  meshPeers: number,
): Health {
  const total = ipfsPeers + meshPeers;
  if (total >= 6) return "connected";
  if (total > 0) return "partial";
  return "disconnected";
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

function NetworkDetail({
  info,
  history,
}: {
  info: DiagnosticsInfo;
  history: History;
}) {
  const gs = info.gossipsub;
  return (
    <div className="cs-detail-section">
      <div className="cs-detail-heading">
        Network
      </div>
      <MultiSparkline
        series={[
          {
            data: history.peers,
            color: "#2563eb",
            label: "libp2p",
          },
          {
            data: history.mesh,
            color: "#f59e0b",
            label: "mesh",
          },
          {
            data: history.relays,
            color: "#22c55e",
            label: "relays",
          },
        ]}
      />
      <div className="cs-detail-cols">
        <div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">
              On document
            </span>
            {info.editors}
          </div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">
              libp2p
            </span>
            {info.ipfsPeers}
          </div>
        </div>
        <div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">
              GossipSub
            </span>
            {gs.peers}
          </div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">
              Mesh
            </span>
            {gs.meshPeers}
          </div>
        </div>
        <div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">
              Topics
            </span>
            {gs.topics}
          </div>
        </div>
      </div>
    </div>
  );
}

function RelaysDetail({
  info,
}: {
  info: DiagnosticsInfo;
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
      <Sparkline
        data={history.clockSum}
        color="#8b5cf6"
      />
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

  const connectedRelays = info.relays.filter(
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
          `${info.editors} user(s), ` +
          `${connectedRelays} relay(s), ` +
          `${info.ipfsPeers} network peers`
        }
      >
        <span className="cs-expand">
          {expanded ? "\u25B4" : "\u25BE"}
        </span>

        <span
          className="cs-section"
          title="Users on this document"
        >
          <span className="cs-value">
            {info.editors}
          </span>
          <span className="cs-label">
            {info.editors === 1 ? "user" : "users"}
          </span>
        </span>

        <span className="cs-divider" />

        <span
          className="cs-section"
          title={
            `${connectedRelays}/` +
            `${info.relays.length} relays`
          }
        >
          <Dot state={
            relayHealth(connectedRelays)
          } />
          <span className="cs-label">Relays</span>
        </span>

        <span className="cs-divider" />

        <span
          className="cs-section"
          title={
            `${info.ipfsPeers} libp2p, ` +
            `${info.gossipsub.meshPeers} mesh`
          }
        >
          <Dot state={networkHealth(
            info.ipfsPeers,
            info.gossipsub.meshPeers,
          )} />
          <span className="cs-label">Network</span>
        </span>

        <SyncSummary info={info} />
      </button>

      {expanded && (
        <div className="cs-detail">
          <NetworkDetail
            info={info}
            history={h}
          />
          <RelaysDetail info={info} />
          <SnapshotsDetail
            info={info}
            history={h}
          />
        </div>
      )}
    </div>
  );
}
