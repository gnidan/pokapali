import { useState, useEffect, useRef } from "react";
import type {
  Doc,
  Diagnostics,
  LoadingState,
  VersionHistory,
} from "@pokapali/core";
import { TopologyMap } from "./TopologyMap";
import { useFeed } from "@pokapali/react";

// --- Time formatting ---

/**
 * Format a future timestamp as a human-readable duration.
 * Returns "expired" if the timestamp is in the past.
 *
 * Examples: "2h 15m", "3 days", "45m", "expired"
 */
export function formatRelativeTime(timestamp: number): string {
  const sec = Math.round((timestamp - Date.now()) / 1000);
  if (sec <= 0) return "expired";
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  const remMin = min - hrs * 60;
  if (hrs < 24) {
    return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
  }
  const days = Math.round(hrs / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

// --- Ring buffer for sparkline history ---

const MAX_SAMPLES = 60;

interface History {
  peers: number[];
  mesh: number[];
  nodes: number[];
  clockSum: number[];
}

function emptyHistory(): History {
  return {
    peers: [],
    mesh: [],
    nodes: [],
    clockSum: [],
  };
}

function pushSample(h: History, info: Diagnostics) {
  h.peers.push(info.ipfsPeers);
  h.mesh.push(info.gossipsub.meshPeers);
  h.nodes.push(info.nodes.filter((n) => n.connected).length);
  h.clockSum.push(info.clockSum);
  for (const key of Object.keys(h) as Array<keyof History>) {
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
    const x = (i / (data.length - 1)) * (width - 2 * pad) + pad;
    const y = height - pad - ((v - min) / range) * (height - 2 * pad);
    return `${x},${y}`;
  });
}

const SPARK_W = 300;
const SPARK_H = 40;
const SPARK_PAD = 2;

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const pts = normalizePoints(data, SPARK_W, SPARK_H, SPARK_PAD);
  const line = pts.join(" ");
  const fill =
    line + ` ${SPARK_W - SPARK_PAD},${SPARK_H}` + ` ${SPARK_PAD},${SPARK_H}`;
  const last = pts[pts.length - 1].split(",");

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <polygon points={fill} fill={color} fillOpacity="0.08" />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
    </svg>
  );
}

function MultiSparkline({ series }: { series: Series[] }) {
  const active = series.filter((s) => s.data.length >= 2);
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
          const pts = normalizePoints(s.data, SPARK_W, SPARK_H, SPARK_PAD);
          const line = pts.join(" ");
          const last = pts[pts.length - 1].split(",");
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
              <circle cx={last[0]} cy={last[1]} r="2.5" fill={s.color} />
            </g>
          );
        })}
      </svg>
      <div className="sparkline-legend">
        {active.map((s) => (
          <span key={s.label} className="legend-item">
            <span className="legend-swatch" style={{ background: s.color }} />
            <span className="legend-label">
              {s.label} {s.data[s.data.length - 1]}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// --- Helpers ---

function Dot({
  state,
}: {
  state: "connected" | "disconnected" | "partial" | "inactive";
}) {
  return <span className={`cs-dot ${state}`} aria-hidden="true" />;
}

function fetchLabel(fs: LoadingState): string {
  switch (fs.status) {
    case "idle":
      return "Idle";
    case "resolving":
      return "Resolving IPNS\u2026";
    case "fetching":
      return `Fetching ...${fs.cid.slice(-8)}`;
    case "retrying": {
      const wait = Math.max(
        0,
        Math.round((fs.nextRetryAt - Date.now()) / 1000),
      );
      return `Retry #${fs.attempt} in ${wait}s`;
    }
    case "failed":
      return `Failed: ${fs.error}`;
  }
}

// --- Summary bar helpers ---

type Health = "connected" | "partial" | "disconnected" | "inactive";

function nodeHealth(connected: number): Health {
  if (connected >= 3) return "connected";
  if (connected > 0) return "partial";
  return "disconnected";
}

function networkHealth(ipfsPeers: number, meshPeers: number): Health {
  const total = ipfsPeers + meshPeers;
  if (total >= 6) return "connected";
  if (total > 0) return "partial";
  return "disconnected";
}

function truncateCid(cid: string): string {
  if (cid.length <= 12) return cid;
  return cid.slice(0, 6) + "\u2026" + cid.slice(-6);
}

function entryStatusLabel(
  status: string,
  loading: LoadingState,
  cid: string,
): string {
  if (status === "available") return "Available";
  if (status === "failed") return "Failed";
  // "loading" — check if this is the active fetch
  if (loading.status === "fetching" && loading.cid === cid) {
    return "Fetching\u2026";
  }
  if (loading.status === "retrying" && loading.cid === cid) {
    const wait = Math.max(
      0,
      Math.round((loading.nextRetryAt - Date.now()) / 1000),
    );
    return `Retry #${loading.attempt} in ${wait}s`;
  }
  return "Queued";
}

function BlockRequestsDropdown({
  versions,
  loading,
}: {
  versions: VersionHistory;
  loading: LoadingState;
}) {
  const pending = versions.entries.filter((e) => e.status !== "available");

  if (pending.length === 0 && !versions.walking) {
    return null;
  }

  return (
    <div className="cs-block-dropdown">
      {versions.walking && (
        <div className="cs-block-row cs-block-walking">
          Walking version chain\u2026
        </div>
      )}
      {pending.map((e) => {
        const cid = e.cid.toString();
        return (
          <div
            key={cid}
            className={
              "cs-block-row" + (e.status === "failed" ? " cs-block-failed" : "")
            }
          >
            <span className="cs-block-cid" title={cid}>
              {truncateCid(cid)}
            </span>
            <span className="cs-block-seq">#{e.seq}</span>
            <span className="cs-block-status">
              {entryStatusLabel(e.status, loading, cid)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SyncSummary({ info, doc }: { info: Diagnostics; doc: Doc }) {
  const versions = useFeed(doc.versions);
  const loading = useFeed(doc.loading);

  const behind =
    Math.max(info.maxPeerClockSum, info.latestAnnouncedSeq) - info.clockSum;
  const fs = info.loadingState;
  const isLoading =
    !info.hasAppliedSnapshot && fs.status !== "failed" && fs.status !== "idle";
  const isFailed = fs.status === "failed";

  const hasPending = versions.entries.some((e) => e.status !== "available");
  const showDropdown = hasPending || versions.walking;

  if (behind <= 0 && !isFailed && !isLoading) {
    return null;
  }

  const label = isLoading
    ? "Loading\u2026"
    : isFailed
      ? "Load failed"
      : `~${behind} edits behind`;

  return (
    <>
      <span className="cs-divider" />
      <span
        className={
          "cs-section cs-sync-summary" +
          (isFailed ? " cs-fetch-failed" : " cs-behind") +
          (showDropdown ? " cs-has-dropdown" : "")
        }
        title={
          `Local: ${info.clockSum}, ` +
          `peers: ${info.maxPeerClockSum}, ` +
          `announced: ${info.latestAnnouncedSeq}`
        }
      >
        {label}
        {showDropdown && (
          <BlockRequestsDropdown versions={versions} loading={loading} />
        )}
      </span>
    </>
  );
}

// --- Expanded detail sections ---

function NetworkDetail({
  info,
  history,
}: {
  info: Diagnostics;
  history: History;
}) {
  const gs = info.gossipsub;
  return (
    <div className="cs-detail-section">
      <div className="cs-detail-heading">Network</div>
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
            data: history.nodes,
            color: "#22c55e",
            label: "nodes",
          },
        ]}
      />
      <div className="cs-detail-cols">
        <div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">On document</span>
            {info.editors}
          </div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">libp2p</span>
            {info.ipfsPeers}
          </div>
        </div>
        <div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">GossipSub</span>
            {gs.peers}
          </div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">Mesh</span>
            {gs.meshPeers}
          </div>
        </div>
        <div>
          <div className="cs-detail-row">
            <span className="cs-detail-key">Topics</span>
            {gs.topics}
          </div>
        </div>
      </div>
    </div>
  );
}

function SnapshotsDetail({
  info,
  history,
}: {
  info: Diagnostics;
  history: History;
}) {
  return (
    <div className="cs-detail-section">
      <div className="cs-detail-heading">Snapshots</div>
      <Sparkline data={history.clockSum} color="#8b5cf6" />
      <div className="cs-detail-row">
        <span className="cs-detail-key">Clock</span>
        <span className="cs-detail-mono">{info.clockSum}</span>
      </div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">IPNS seq</span>
        <span className="cs-detail-mono">{info.ipnsSeq ?? "\u2014"}</span>
      </div>
      <div className="cs-detail-row">
        <span className="cs-detail-key">Fetch</span>
        <span
          className={
            info.loadingState.status === "failed" ? "cs-detail-warn" : ""
          }
        >
          {fetchLabel(info.loadingState)}
        </span>
      </div>
      {info.ackedBy.length > 0 && (
        <div className="cs-detail-row">
          <span className="cs-detail-key">Acked</span>
          <span className="cs-detail-mono">
            {info.ackedBy.length}{" "}
            {info.ackedBy.length === 1 ? "pinner" : "pinners"}
          </span>
        </div>
      )}
      {info.guaranteeUntil != null && (
        <div className="cs-detail-row">
          <span className="cs-detail-key">Pinned until</span>
          <span
            className={
              info.guaranteeUntil < Date.now()
                ? "cs-detail-warn"
                : "cs-detail-mono"
            }
          >
            {info.guaranteeUntil < Date.now()
              ? "Guarantee expired"
              : formatRelativeTime(info.guaranteeUntil)}
          </span>
        </div>
      )}
      {info.retainUntil != null && (
        <div className="cs-detail-row">
          <span className="cs-detail-key">Stored until</span>
          <span
            className={
              info.retainUntil < Date.now()
                ? "cs-detail-warn"
                : "cs-detail-mono"
            }
          >
            {info.retainUntil < Date.now()
              ? "Retention expired"
              : formatRelativeTime(info.retainUntil)}
          </span>
        </div>
      )}
    </div>
  );
}

// --- Main component ---

export function ConnectionStatus({ doc }: { doc: Doc }) {
  const [info, setInfo] = useState<Diagnostics>(() => doc.diagnostics());
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

    const unsubs = [
      doc.status.subscribe(refresh),
      doc.saveState.subscribe(refresh),
      doc.snapshotEvents.subscribe(refresh),
      doc.tip.subscribe(refresh),
      doc.loading.subscribe(refresh),
    ];
    doc.on("node-change", refresh);
    const awareness = doc.awareness;
    awareness.on("change", refresh);

    // Fallback poll for libp2p peer counts
    // (no event for peer connect/disconnect)
    const poll = setInterval(refresh, 10_000);

    return () => {
      active = false;
      unsubs.forEach((u) => u());
      doc.off("node-change", refresh);
      awareness.off("change", refresh);
      clearInterval(poll);
    };
  }, [doc]);

  const connectedNodes = info.nodes.filter((n) => n.connected).length;
  const h = historyRef.current;

  return (
    <div className="connection-status-wrap">
      {/* Summary bar */}
      <div
        className="connection-status"
        aria-label={
          `${info.editors} user(s), ` +
          `${connectedNodes} ` +
          `${connectedNodes === 1 ? "node" : "nodes"}, ` +
          `${info.ipfsPeers} network peers`
        }
      >
        <span
          className="cs-section"
          title="Users on this document"
          data-testid="cs-users-count"
        >
          <span className="cs-value">{info.editors}</span>
          <span className="cs-label">
            {info.editors === 1 ? "user" : "users"}
          </span>
        </span>

        <span className="cs-divider" />

        <span
          className="cs-section"
          title={`${connectedNodes}/` + `${info.nodes.length} nodes`}
          data-testid="cs-node-status"
        >
          <Dot state={nodeHealth(connectedNodes)} />
          <span className="cs-label">Pokapali nodes</span>
        </span>

        <span className="cs-divider" />

        <span
          className="cs-section"
          title={
            `${info.ipfsPeers} libp2p, ` + `${info.gossipsub.meshPeers} mesh`
          }
          data-testid="cs-network-status"
        >
          <Dot
            state={networkHealth(info.ipfsPeers, info.gossipsub.meshPeers)}
          />
          <span className="cs-label">libp2p network</span>
        </span>

        <SyncSummary info={info} doc={doc} />

        {doc.capability.canPushSnapshots &&
          !info.nodes.some(
            (n) => n.connected && n.roles.includes("pinner"),
          ) && (
            <>
              <span className="cs-divider" />
              {info.nodes.some((n) => n.connected && !n.rolesConfirmed) ? (
                <span
                  className={"cs-section cs-checking-pinners"}
                  title={"Waiting for node capability broadcasts\u2026"}
                >
                  Checking for pinners…
                </span>
              ) : (
                <span
                  className={"cs-section cs-no-pinner"}
                  title={"No pinners connected \u2014 changes may not persist"}
                >
                  No connected pinners
                </span>
              )}
            </>
          )}
      </div>

      {/* Detail panel — always visible */}
      <div className="cs-detail">
        <TopologyMap doc={doc} />
        <NetworkDetail info={info} history={h} />
        <SnapshotsDetail info={info} history={h} />
      </div>
    </div>
  );
}
