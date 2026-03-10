import { useState, useEffect, useRef } from "react";
import type {
  NodeInfo,
  Diagnostics,
  TopologyEdge,
} from "@pokapali/core";
import { formatRelativeTime } from "./ConnectionStatus";

// --- Graph types ---

type NodeKind =
  | "self"
  | "relay"
  | "pinner"
  | "relay+pinner"
  | "browser";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  connected: boolean;
  ackedCurrentCid: boolean;
  guaranteeLabel?: string;
  guaranteeActive?: boolean;
  browserCount?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  connected: boolean;
}

export interface TopologyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// --- Determine node kind ---

function nodeKind(roles: string[]): NodeKind {
  const isPinner = roles.includes("pinner");
  const isRelay = roles.includes("relay");
  if (isPinner && isRelay) return "relay+pinner";
  if (isPinner) return "pinner";
  if (isRelay) return "relay";
  return "browser";
}

// --- Build graph from diagnostics ---

interface AwarenessPeer {
  name: string;
  color: string;
}

export function buildGraph(
  info: Diagnostics,
  awarenessPeers: AwarenessPeer[],
): TopologyGraph {
  const now = Date.now();
  const graphNodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Self node
  graphNodes.push({
    id: "_self",
    label: "You",
    kind: "self",
    connected: true,
    ackedCurrentCid: false,
  });

  // Infrastructure nodes from diagnostics
  for (const n of info.nodes) {
    const kind = nodeKind(n.roles);
    let guaranteeLabel: string | undefined;
    let guaranteeActive: boolean | undefined;

    // Show guarantee info on acked pinners
    if (
      n.ackedCurrentCid &&
      kind !== "relay" &&
      info.guaranteeUntil != null
    ) {
      guaranteeActive =
        info.guaranteeUntil > now;
      guaranteeLabel = guaranteeActive
        ? formatRelativeTime(info.guaranteeUntil)
        : "expired";
    }

    graphNodes.push({
      id: n.peerId,
      label: `...${n.short}`,
      kind,
      connected: n.connected,
      ackedCurrentCid: n.ackedCurrentCid,
      guaranteeLabel,
      guaranteeActive,
      browserCount: n.browserCount,
    });
    edges.push({
      from: "_self",
      to: n.peerId,
      connected: n.connected,
    });
  }

  // Topology edges from core (relay-to-relay etc)
  for (const te of info.topology) {
    // Avoid duplicating self→node edges
    const already = edges.some(
      (e) =>
        (e.from === te.source &&
          e.to === te.target) ||
        (e.from === te.target &&
          e.to === te.source),
    );
    if (!already) {
      edges.push({
        from: te.source,
        to: te.target,
        connected: true,
      });
    }
  }

  // WebRTC peers (other browsers)
  if (awarenessPeers.length > 0) {
    // Group as a single "peers" node with count
    graphNodes.push({
      id: "_peers",
      label: awarenessPeers.length === 1
        ? awarenessPeers[0].name || "Anonymous"
        : `${awarenessPeers.length} peers`,
      kind: "browser",
      connected: true,
      ackedCurrentCid: false,
      browserCount: awarenessPeers.length,
    });
    edges.push({
      from: "_self",
      to: "_peers",
      connected: true,
    });
  }

  return { nodes: graphNodes, edges };
}

// --- Layout ---

interface Positioned {
  node: GraphNode;
  x: number;
  y: number;
}

const SIZE = 300;
const CX = SIZE / 2;
const CY = SIZE / 2;
const INFRA_R = 105;
const PEER_R = 60;
const NODE_R = 16;
const SELF_R = 20;

function layout(graph: TopologyGraph): Positioned[] {
  const result: Positioned[] = [];
  const infra = graph.nodes.filter(
    (n) =>
      n.kind !== "self" && n.kind !== "browser",
  );
  const browsers = graph.nodes.filter(
    (n) => n.kind === "browser",
  );

  // Self in center
  for (const n of graph.nodes) {
    if (n.kind === "self") {
      result.push({ node: n, x: CX, y: CY });
    }
  }

  // Infrastructure in outer ring
  infra.forEach((n, i) => {
    const angle =
      -Math.PI / 2 +
      (2 * Math.PI * i) /
        Math.max(infra.length, 1);
    result.push({
      node: n,
      x: CX + INFRA_R * Math.cos(angle),
      y: CY + INFRA_R * Math.sin(angle),
    });
  });

  // Browser peers in inner ring
  browsers.forEach((n, i) => {
    const offset = infra.length > 0
      ? Math.PI / infra.length
      : 0;
    const angle =
      -Math.PI / 2 +
      offset +
      (2 * Math.PI * i) /
        Math.max(browsers.length, 1);
    result.push({
      node: n,
      x: CX + PEER_R * Math.cos(angle),
      y: CY + PEER_R * Math.sin(angle),
    });
  });

  return result;
}

// --- Colors ---

const COLORS = {
  relay: "#2563eb",
  pinner: "#a855f7",
  "relay+pinner": "#7c3aed",
  browser: "#059669",
  self: "#059669",
  disconnected: "#d1d5db",
  guaranteeActive: "#22c55e",
  guaranteeExpired: "#ef4444",
};

function fillColor(n: GraphNode): string {
  if (!n.connected && n.kind !== "self") {
    return "#f3f4f6";
  }
  return COLORS[n.kind] || "#6b7280";
}

function strokeColor(
  n: GraphNode,
  pulse: boolean,
): string {
  if (pulse && n.connected) return "#fbbf24";
  if (!n.connected && n.kind !== "self") {
    return COLORS.disconnected;
  }
  return COLORS[n.kind] || "#6b7280";
}

// --- Shape paths ---

// Hexagon path centered at (0,0) with radius r
function hexPath(r: number): string {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(
      `${r * Math.cos(a)},${r * Math.sin(a)}`,
    );
  }
  return pts.join(" ");
}

// --- SVG shapes ---

function RelayShape({
  x, y, fill, stroke, opacity, sw,
}: {
  x: number; y: number;
  fill: string; stroke: string;
  opacity: number; sw: number;
}) {
  const w = NODE_R * 2;
  const h = NODE_R * 1.4;
  return (
    <rect
      x={x - w / 2} y={y - h / 2}
      width={w} height={h}
      rx={4} ry={4}
      fill={fill} stroke={stroke}
      strokeWidth={sw} opacity={opacity}
    />
  );
}

function PinnerShape({
  x, y, fill, stroke, opacity, sw,
}: {
  x: number; y: number;
  fill: string; stroke: string;
  opacity: number; sw: number;
}) {
  return (
    <polygon
      points={hexPath(NODE_R + 2)}
      transform={`translate(${x},${y})`}
      fill={fill} stroke={stroke}
      strokeWidth={sw} opacity={opacity}
      strokeLinejoin="round"
    />
  );
}

function BrowserShape({
  x, y, fill, stroke, opacity, sw,
}: {
  x: number; y: number;
  fill: string; stroke: string;
  opacity: number; sw: number;
}) {
  return (
    <circle
      cx={x} cy={y} r={12}
      fill={fill} stroke={stroke}
      strokeWidth={sw} opacity={opacity}
    />
  );
}

// --- Node rendering ---

function NodeShape({ pos, pulse }: {
  pos: Positioned;
  pulse: boolean;
}) {
  const n = pos.node;
  const fill = fillColor(n);
  const stroke = strokeColor(n, pulse);
  const op = n.connected || n.kind === "self"
    ? 1 : 0.5;

  // Build title text
  const titleParts = [n.label];
  if (n.kind !== "self" && n.kind !== "browser") {
    titleParts.push(`(${n.kind})`);
  }
  if (n.ackedCurrentCid) titleParts.push("— acked");
  if (n.guaranteeLabel) {
    titleParts.push(`— pinned ${n.guaranteeLabel}`);
  }
  if (!n.connected && n.kind !== "self") {
    titleParts.push("— disconnected");
  }

  // Choose shape
  let shape: React.ReactNode;
  if (n.kind === "self") {
    shape = (
      <circle
        cx={pos.x} cy={pos.y} r={SELF_R}
        fill={fill} stroke={stroke}
        strokeWidth={3} opacity={op}
      />
    );
  } else if (n.kind === "relay") {
    shape = (
      <RelayShape
        x={pos.x} y={pos.y}
        fill={fill} stroke={stroke}
        opacity={op} sw={2}
      />
    );
  } else if (n.kind === "pinner") {
    shape = (
      <PinnerShape
        x={pos.x} y={pos.y}
        fill={fill} stroke={stroke}
        opacity={op} sw={2}
      />
    );
  } else if (n.kind === "relay+pinner") {
    // Hexagon with rounded-rect outline
    shape = (
      <PinnerShape
        x={pos.x} y={pos.y}
        fill={fill} stroke={stroke}
        opacity={op} sw={2.5}
      />
    );
  } else {
    // Browser peer
    shape = (
      <BrowserShape
        x={pos.x} y={pos.y}
        fill={fill} stroke={stroke}
        opacity={op} sw={1.5}
      />
    );
  }

  // Label: icon letter for infra, name for others
  let labelText = "";
  if (n.kind === "self") {
    labelText = "You";
  } else if (n.kind === "browser") {
    labelText = n.browserCount && n.browserCount > 1
      ? String(n.browserCount)
      : (n.label.charAt(0) || "?").toUpperCase();
  } else if (n.kind === "relay") {
    labelText = "R";
  } else if (n.kind === "pinner") {
    labelText = "P";
  } else {
    labelText = "RP";
  }

  return (
    <g className="topo-node">
      <title>{titleParts.join(" ")}</title>

      {/* Guarantee ring on pinners */}
      {n.guaranteeLabel && (
        <circle
          cx={pos.x} cy={pos.y}
          r={NODE_R + 5}
          fill="none"
          stroke={
            n.guaranteeActive
              ? COLORS.guaranteeActive
              : COLORS.guaranteeExpired
          }
          strokeWidth="2"
          strokeDasharray={
            n.guaranteeActive ? "none" : "3 2"
          }
          opacity={0.7}
        />
      )}

      {/* Pulse ring */}
      {pulse && n.connected &&
        n.kind !== "self" && (
        <circle
          cx={pos.x} cy={pos.y}
          r={(n.kind === "browser" ? 12 : NODE_R) + 4}
          fill="none"
          stroke="#fbbf24"
          strokeWidth="2"
          opacity="0.5"
          className="topo-pulse-ring"
        />
      )}

      {shape}

      {/* Label text */}
      <text
        x={pos.x} y={pos.y + 1}
        textAnchor="middle"
        dominantBaseline="central"
        className={
          n.kind === "self"
            ? "topo-label-self"
            : n.kind === "browser"
              ? "topo-label-peer"
              : "topo-label"
        }
      >
        {labelText}
      </text>

      {/* Ack checkmark on pinners */}
      {n.ackedCurrentCid && (
        <text
          x={pos.x + NODE_R - 1}
          y={pos.y - NODE_R + 4}
          className="topo-ack"
        >
          ✓
        </text>
      )}

      {/* Role label below shape */}
      {n.kind !== "self" &&
        n.kind !== "browser" && (
        <text
          x={pos.x}
          y={pos.y + NODE_R + 12}
          textAnchor="middle"
          className="topo-role"
          fill={COLORS[n.kind] || "#6b7280"}
        >
          {n.kind === "relay+pinner"
            ? "relay+pinner"
            : n.kind}
        </text>
      )}

      {/* Guarantee time below role */}
      {n.guaranteeLabel && (
        <text
          x={pos.x}
          y={pos.y + NODE_R + 21}
          textAnchor="middle"
          className="topo-guarantee"
          fill={
            n.guaranteeActive
              ? COLORS.guaranteeActive
              : COLORS.guaranteeExpired
          }
        >
          {n.guaranteeActive
            ? `pinned ${n.guaranteeLabel}`
            : "expired"}
        </text>
      )}

      {/* Peer ID below */}
      {n.kind !== "self" && (
        <text
          x={pos.x}
          y={
            pos.y +
            (n.kind === "browser" ? 12 : NODE_R) +
            (n.guaranteeLabel ? 30 : 22)
          }
          textAnchor="middle"
          className="topo-peer-id"
        >
          {n.kind === "browser"
            ? n.label
            : n.label}
        </text>
      )}

      {/* Browser count badge on relay nodes */}
      {n.kind !== "self" &&
        n.kind !== "browser" &&
        n.browserCount != null &&
        n.browserCount > 0 && (
        <g>
          <circle
            cx={pos.x + NODE_R}
            cy={pos.y - NODE_R}
            r={7}
            fill="#059669"
            stroke="#fff"
            strokeWidth="1.5"
          />
          <text
            x={pos.x + NODE_R}
            y={pos.y - NODE_R + 1}
            textAnchor="middle"
            dominantBaseline="central"
            className="topo-badge-text"
          >
            {n.browserCount}
          </text>
        </g>
      )}
    </g>
  );
}

function EdgeLine({
  x1, y1, x2, y2, connected, pulse,
}: {
  x1: number; y1: number;
  x2: number; y2: number;
  connected: boolean;
  pulse: boolean;
}) {
  return (
    <line
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={
        pulse && connected
          ? "#fbbf24"
          : connected
            ? "#94a3b8"
            : "#e5e7eb"
      }
      strokeWidth={connected ? 1.5 : 1}
      strokeDasharray={connected ? "none" : "4 3"}
      strokeOpacity={connected ? 0.5 : 0.3}
      className={
        pulse && connected
          ? "topo-edge-pulse"
          : ""
      }
    />
  );
}

// --- Legend ---

function Legend() {
  return (
    <g className="topo-legend" transform="translate(4,4)">
      {/* Relay */}
      <rect
        x={0} y={0} width={10} height={7}
        rx={2} fill={COLORS.relay}
      />
      <text x={14} y={7} className="topo-legend-text">
        Relay
      </text>
      {/* Pinner */}
      <polygon
        points="38,0 43,3.5 38,7 33,3.5"
        fill={COLORS.pinner}
      />
      <text x={47} y={7} className="topo-legend-text">
        Pinner
      </text>
      {/* Browser */}
      <circle
        cx={80} cy={3.5} r={3.5}
        fill={COLORS.browser}
      />
      <text x={86} y={7} className="topo-legend-text">
        Peer
      </text>
    </g>
  );
}

// --- Main component ---

export function TopologyMap({
  info,
  awarenessPeers,
  pulseKey,
}: {
  info: Diagnostics;
  awarenessPeers: AwarenessPeer[];
  pulseKey: number;
}) {
  // Debounce graph updates to avoid flicker
  const [graph, setGraph] = useState(() =>
    buildGraph(info, awarenessPeers),
  );
  const debounceRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const prevCountRef = useRef(info.nodes.length);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Immediate update if node count changes
    const countChanged =
      info.nodes.length !== prevCountRef.current;
    prevCountRef.current = info.nodes.length;

    if (countChanged) {
      setGraph(buildGraph(info, awarenessPeers));
    } else {
      debounceRef.current = setTimeout(() => {
        setGraph(
          buildGraph(info, awarenessPeers),
        );
      }, 10_000);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [info, awarenessPeers]);

  // Pulse animation on snapshot/ack
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    if (pulseKey === 0) return;
    setPulse(true);
    if (pulseTimer.current) {
      clearTimeout(pulseTimer.current);
    }
    pulseTimer.current = setTimeout(
      () => setPulse(false),
      1_500,
    );
    return () => {
      if (pulseTimer.current) {
        clearTimeout(pulseTimer.current);
      }
    };
  }, [pulseKey]);

  const positions = layout(graph);
  const selfPos = positions.find(
    (p) => p.node.kind === "self",
  )!;

  return (
    <div className="topo-wrap">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="topo-svg"
        aria-label="Network topology"
      >
        <Legend />

        {/* Edges first (behind nodes) */}
        {graph.edges.map((e) => {
          const from = positions.find(
            (p) => p.node.id === e.from,
          );
          const to = positions.find(
            (p) => p.node.id === e.to,
          );
          if (!from || !to) return null;
          return (
            <EdgeLine
              key={`${e.from}-${e.to}`}
              x1={from.x} y1={from.y}
              x2={to.x} y2={to.y}
              connected={e.connected}
              pulse={pulse}
            />
          );
        })}

        {/* Nodes: browsers, then infra, then self */}
        {positions
          .filter(
            (p) => p.node.kind === "browser",
          )
          .map((p) => (
            <NodeShape
              key={p.node.id}
              pos={p}
              pulse={pulse}
            />
          ))}
        {positions
          .filter(
            (p) =>
              p.node.kind !== "self" &&
              p.node.kind !== "browser",
          )
          .map((p) => (
            <NodeShape
              key={p.node.id}
              pos={p}
              pulse={pulse}
            />
          ))}
        <NodeShape pos={selfPos} pulse={false} />
      </svg>
    </div>
  );
}
