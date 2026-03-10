import { useState, useEffect, useRef } from "react";
import type { NodeInfo } from "@pokapali/core";

// --- Graph types ---

export interface GraphNode {
  id: string;
  label: string;
  roles: string[];
  rolesConfirmed: boolean;
  connected: boolean;
  ackedCurrentCid: boolean;
  isSelf?: boolean;
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

// --- Build star topology from diagnostics ---

export function buildStarGraph(
  nodes: NodeInfo[],
  editors: number,
): TopologyGraph {
  const self: GraphNode = {
    id: "_self",
    label: "You",
    roles: ["browser"],
    rolesConfirmed: true,
    connected: true,
    ackedCurrentCid: false,
    isSelf: true,
    browserCount: Math.max(0, editors - 1),
  };

  const graphNodes: GraphNode[] = [self];
  const edges: GraphEdge[] = [];

  for (const n of nodes) {
    graphNodes.push({
      id: n.peerId,
      label: `...${n.short}`,
      roles: n.roles,
      rolesConfirmed: n.rolesConfirmed,
      connected: n.connected,
      ackedCurrentCid: n.ackedCurrentCid,
    });
    edges.push({
      from: "_self",
      to: n.peerId,
      connected: n.connected,
    });
  }

  return { nodes: graphNodes, edges };
}

// --- Layout: position nodes in a circle ---

interface Positioned {
  node: GraphNode;
  x: number;
  y: number;
}

const SIZE = 280;
const CX = SIZE / 2;
const CY = SIZE / 2;
const RADIUS = 100;
const NODE_R = 18;
const SELF_R = 22;

function layout(graph: TopologyGraph): Positioned[] {
  const result: Positioned[] = [];
  const others = graph.nodes.filter((n) => !n.isSelf);

  for (const n of graph.nodes) {
    if (n.isSelf) {
      result.push({ node: n, x: CX, y: CY });
    }
  }

  others.forEach((n, i) => {
    const angle =
      -Math.PI / 2 +
      (2 * Math.PI * i) / Math.max(others.length, 1);
    result.push({
      node: n,
      x: CX + RADIUS * Math.cos(angle),
      y: CY + RADIUS * Math.sin(angle),
    });
  });

  return result;
}

// --- Role colors ---

function nodeColor(roles: string[]): string {
  const isPinner = roles.includes("pinner");
  const isRelay = roles.includes("relay");
  if (isPinner && isRelay) return "#7c3aed";
  if (isPinner) return "#a855f7";
  if (isRelay) return "#2563eb";
  if (roles.includes("browser")) return "#059669";
  return "#6b7280";
}

function nodeStroke(
  node: GraphNode,
  pulse: boolean,
): string {
  if (pulse && node.connected) return "#fbbf24";
  if (!node.connected && !node.isSelf) return "#d1d5db";
  return nodeColor(node.roles);
}

// --- SVG components ---

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
            ? "#22c55e"
            : "#e5e7eb"
      }
      strokeWidth={connected ? 2 : 1}
      strokeDasharray={connected ? "none" : "4 3"}
      strokeOpacity={connected ? 0.8 : 0.4}
      className={
        pulse && connected ? "topo-edge-pulse" : ""
      }
    />
  );
}

function NodeCircle({ pos, pulse }: {
  pos: Positioned;
  pulse: boolean;
}) {
  const n = pos.node;
  const r = n.isSelf ? SELF_R : NODE_R;
  const fill = n.connected || n.isSelf
    ? nodeColor(n.roles)
    : "#f3f4f6";
  const stroke = nodeStroke(n, pulse);
  const initial = n.isSelf
    ? "You"
    : n.label.charAt(3)?.toUpperCase() || "?";

  return (
    <g className="topo-node">
      <title>
        {n.label}
        {n.roles.length > 0
          ? ` (${n.roles.join(", ")})`
          : ""}
        {n.ackedCurrentCid ? " — acked" : ""}
        {!n.connected && !n.isSelf
          ? " — disconnected"
          : ""}
      </title>

      {/* Pulse ring */}
      {pulse && n.connected && !n.isSelf && (
        <circle
          cx={pos.x} cy={pos.y} r={r + 4}
          fill="none"
          stroke="#fbbf24"
          strokeWidth="2"
          opacity="0.5"
          className="topo-pulse-ring"
        />
      )}

      {/* Main circle */}
      <circle
        cx={pos.x} cy={pos.y} r={r}
        fill={fill}
        stroke={stroke}
        strokeWidth={n.isSelf ? 3 : 2}
        opacity={
          n.connected || n.isSelf ? 1 : 0.5
        }
      />

      {/* Label */}
      {n.isSelf ? (
        <text
          x={pos.x} y={pos.y + 1}
          textAnchor="middle"
          dominantBaseline="central"
          className="topo-label-self"
        >
          You
        </text>
      ) : (
        <text
          x={pos.x} y={pos.y + 1}
          textAnchor="middle"
          dominantBaseline="central"
          className="topo-label"
        >
          {initial}
        </text>
      )}

      {/* Role badges below node */}
      {!n.isSelf && n.roles.length > 0 && (
        <text
          x={pos.x} y={pos.y + r + 11}
          textAnchor="middle"
          className="topo-role"
          fill={nodeColor(n.roles)}
        >
          {n.roles.join("+")}
        </text>
      )}

      {/* Ack checkmark */}
      {n.ackedCurrentCid && (
        <text
          x={pos.x + r - 2}
          y={pos.y - r + 6}
          className="topo-ack"
        >
          ✓
        </text>
      )}

      {/* Browser count badge on self */}
      {n.isSelf &&
        n.browserCount != null &&
        n.browserCount > 0 && (
        <g>
          <circle
            cx={pos.x + SELF_R - 2}
            cy={pos.y - SELF_R + 4}
            r={8}
            fill="#059669"
            stroke="#fff"
            strokeWidth="1.5"
          />
          <text
            x={pos.x + SELF_R - 2}
            y={pos.y - SELF_R + 5}
            textAnchor="middle"
            dominantBaseline="central"
            className="topo-badge-text"
          >
            +{n.browserCount}
          </text>
        </g>
      )}

      {/* Peer ID below role */}
      {!n.isSelf && (
        <text
          x={pos.x}
          y={pos.y + r + (n.roles.length > 0 ? 21 : 11)}
          textAnchor="middle"
          className="topo-peer-id"
        >
          {n.label}
        </text>
      )}
    </g>
  );
}

// --- Main component ---

export function TopologyMap({
  nodes,
  editors,
  pulseKey,
}: {
  nodes: NodeInfo[];
  editors: number;
  pulseKey: number;
}) {
  // Debounce graph updates to avoid flicker
  const [graph, setGraph] = useState(() =>
    buildStarGraph(nodes, editors),
  );
  const debounceRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      setGraph(buildStarGraph(nodes, editors));
    }, 10_000);

    // Immediate update if node count changes
    const curr = graph.nodes.length;
    const next = nodes.length + 1;
    if (curr !== next) {
      setGraph(buildStarGraph(nodes, editors));
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [nodes, editors]);

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
    (p) => p.node.isSelf,
  )!;

  return (
    <div className="topo-wrap">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="topo-svg"
        aria-label="Network topology"
      >
        {/* Edges */}
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

        {/* Nodes (self last so it's on top) */}
        {positions
          .filter((p) => !p.node.isSelf)
          .map((p) => (
            <NodeCircle
              key={p.node.id}
              pos={p}
              pulse={pulse}
            />
          ))}
        <NodeCircle pos={selfPos} pulse={false} />
      </svg>
    </div>
  );
}
