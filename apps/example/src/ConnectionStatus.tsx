import { useState, useEffect, useRef, useCallback } from "react";
import type {
  Doc,
  Diagnostics,
  LoadingState,
  VersionHistory,
} from "@pokapali/core";
import { TopologyMap } from "./TopologyMap";
import {
  useFeed,
  usePeerPresenceState,
  type PeerPresenceResult,
} from "@pokapali/react";

// --- Time formatting ---

/**
 * Format a future timestamp as a human-readable
 * duration. Returns "expired" if the timestamp is
 * in the past.
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

export interface History {
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

export function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const pts = normalizePoints(data, SPARK_W, SPARK_H, SPARK_PAD);
  const line = pts.join(" ");
  const fill =
    line + ` ${SPARK_W - SPARK_PAD},${SPARK_H}` + ` ${SPARK_PAD},${SPARK_H}`;
  const last = pts[pts.length - 1]!.split(",");

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
      <circle cx={last[0]!} cy={last[1]!} r="2.5" fill={color} />
    </svg>
  );
}

export function MultiSparkline({ series }: { series: Series[] }) {
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
          const last = pts[pts.length - 1]!.split(",");
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
              <circle cx={last[0]!} cy={last[1]!} r="2.5" fill={s.color} />
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

export function Dot({
  state,
}: {
  state: "connected" | "disconnected" | "partial" | "inactive";
}) {
  return <span className={`cs-dot ${state}`} aria-hidden="true" />;
}

export function fetchLabel(fs: LoadingState): string {
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

export function nodeHealth(connected: number): Health {
  if (connected >= 3) return "connected";
  if (connected > 0) return "partial";
  return "disconnected";
}

export function networkHealth(ipfsPeers: number, meshPeers: number): Health {
  const total = ipfsPeers + meshPeers;
  if (total >= 6) return "connected";
  if (total > 0) return "partial";
  return "disconnected";
}

function truncateCid(cid: string): string {
  if (cid.length <= 12) return cid;
  return cid.slice(0, 6) + "\u2026" + cid.slice(-6);
}

export function entryStatusLabel(
  status: string,
  loading: LoadingState,
  cid: string,
): string {
  if (status === "available") return "Loaded";
  if (status === "failed") return "Failed";
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

export function BlockRequestsDrawer({
  versions,
  loading,
}: {
  versions: VersionHistory;
  loading: LoadingState;
}) {
  if (versions.entries.length === 0 && !versions.walking) {
    return null;
  }

  return (
    <div
      className="cs-block-drawer"
      data-testid="cs-block-drawer"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cs-block-drawer-header">Block requests</div>
      {versions.walking && (
        <div className="cs-block-row cs-block-walking">
          Walking version chain…
        </div>
      )}
      {versions.entries.map((e) => {
        const cid = e.cid.toString();
        return (
          <div
            key={cid}
            className={
              "cs-block-row" +
              (e.status === "failed" ? " cs-block-failed" : "") +
              (e.status === "available" ? " cs-block-available" : "")
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

// --- SyncSummary (props-driven) ---

export interface SyncSummaryProps {
  info: Diagnostics;
  versions: VersionHistory;
  loading: LoadingState;
}

export function SyncSummary({ info, versions, loading }: SyncSummaryProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const behind =
    Math.max(info.maxPeerClockSum, info.latestAnnouncedSeq) - info.clockSum;
  const fs = info.loadingState;
  const isLoading =
    !info.hasAppliedSnapshot && fs.status !== "failed" && fs.status !== "idle";
  const isFailed = fs.status === "failed";

  const hasPending = versions.entries.some((e) => e.status !== "available");
  const hasEntries = versions.entries.length > 0;
  const hasDrawer = hasEntries || hasPending || versions.walking;

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, handleClickOutside]);

  if (behind <= 0 && !isFailed && !isLoading && !hasEntries) {
    return null;
  }

  const label = isLoading
    ? "Loading…"
    : isFailed
      ? "Load failed"
      : behind > 0
        ? `~${behind} edits behind`
        : `${versions.entries.length} versions loaded`;

  const stateClass = isFailed
    ? " cs-fetch-failed"
    : behind > 0 || isLoading
      ? " cs-behind"
      : " cs-synced";

  return (
    <>
      <span className="cs-divider" />
      <span
        ref={wrapRef}
        className={
          "cs-section cs-sync-summary" +
          stateClass +
          (hasDrawer ? " cs-has-dropdown" : "")
        }
        title={
          `Local: ${info.clockSum}, ` +
          `peers: ${info.maxPeerClockSum}, ` +
          `announced: ${info.latestAnnouncedSeq}`
        }
        onClick={hasDrawer ? () => setOpen((v) => !v) : undefined}
        data-testid="cs-sync-summary"
      >
        {label}
        {hasDrawer && open && (
          <BlockRequestsDrawer versions={versions} loading={loading} />
        )}
      </span>
    </>
  );
}

// --- Expanded detail sections ---

export function NetworkDetail({
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

export function SnapshotsDetail({
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

// --- useConnectionDiagnostics hook ---

export interface ConnectionDiagnostics {
  info: Diagnostics;
  history: History;
}

export function useConnectionDiagnostics(doc: Doc): ConnectionDiagnostics {
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

  return { info, history: historyRef.current };
}

// --- ConnectionStatusView (presentational) ---

/**
 * Derive a self-inclusive presence label. The hook
 * counts peers excluding self, but the status bar
 * should show total users including self.
 */
function presenceLabel(
  state: PeerPresenceResult["state"],
  peerCount: number,
): string {
  switch (state) {
    case "connecting":
      return "Connecting\u2026";
    case "looking":
      return "Looking for peers\u2026";
    case "reconnecting":
      return "Reconnecting\u2026";
    case "active": {
      const total = peerCount + 1;
      return total === 1 ? "Just you" : `${total} users editing`;
    }
  }
}

export interface ConnectionStatusViewProps {
  info: Diagnostics;
  history: History;
  versions: VersionHistory;
  loading: LoadingState;
  canPushSnapshots: boolean;
  presence: PeerPresenceResult;
  topologyMap?: React.ReactNode;
}

export function ConnectionStatusView({
  info,
  history,
  versions,
  loading,
  canPushSnapshots,
  presence,
  topologyMap,
}: ConnectionStatusViewProps) {
  const connectedNodes = info.nodes.filter((n) => n.connected).length;
  const pLabel = presenceLabel(presence.state, presence.peerCount);

  return (
    <div className="connection-status-wrap">
      {/* Summary bar */}
      <div
        className="connection-status"
        aria-label={
          `${pLabel}, ` +
          `${connectedNodes} ` +
          `${connectedNodes === 1 ? "node" : "nodes"}, ` +
          `${info.ipfsPeers} network peers`
        }
      >
        <span
          className={"cs-section" + ` poka-peer-presence--${presence.state}`}
          role="status"
          aria-label={pLabel}
          title="Users on this document"
          data-testid="cs-users-count"
        >
          <span
            className={
              "poka-peer-presence__dot" +
              ` poka-peer-presence__dot--${presence.state}`
            }
            aria-hidden="true"
          />
          <span className="cs-label">{pLabel}</span>
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

        <SyncSummary info={info} versions={versions} loading={loading} />

        {canPushSnapshots &&
          !info.nodes.some(
            (n) => n.connected && n.roles.includes("pinner"),
          ) && (
            <>
              <span className="cs-divider" />
              {info.nodes.some((n) => n.connected && !n.rolesConfirmed) ? (
                <span
                  className={"cs-section cs-checking-pinners"}
                  title={"Waiting for node capability " + "broadcasts\u2026"}
                >
                  Checking for pinners…
                </span>
              ) : (
                <span
                  className={"cs-section cs-no-pinner"}
                  title={
                    "No pinners connected \u2014 " + "changes may not persist"
                  }
                >
                  No connected pinners
                </span>
              )}
            </>
          )}
      </div>

      {/* Detail panel — always visible */}
      <div className="cs-detail">
        {topologyMap}
        <NetworkDetail info={info} history={history} />
        <SnapshotsDetail info={info} history={history} />
      </div>
    </div>
  );
}

// --- ConnectionStatus (thin orchestrator) ---

export function ConnectionStatus({ doc }: { doc: Doc }) {
  const { info, history } = useConnectionDiagnostics(doc);
  const versions = useFeed(doc.versions);
  const loading = useFeed(doc.loading);
  const presence = usePeerPresenceState(doc);

  return (
    <ConnectionStatusView
      info={info}
      history={history}
      versions={versions}
      loading={loading}
      canPushSnapshots={doc.capability.canPushSnapshots}
      presence={presence}
      topologyMap={<TopologyMap doc={doc} />}
    />
  );
}
