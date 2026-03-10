import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from "d3-force";
import type {
  Simulation,
  SimulationNodeDatum,
} from "d3-force";
import type { Diagnostics } from "@pokapali/core";
import { formatRelativeTime } from "./ConnectionStatus";

// ── Types ────────────────────────────────────────

type NodeKind =
  | "self"
  | "relay"
  | "pinner"
  | "relay+pinner"
  | "browser";

interface GNode {
  id: string;
  label: string;
  kind: NodeKind;
  connected: boolean;
  ackedCurrentCid: boolean;
  guaranteeLabel?: string;
  guaranteeActive?: boolean;
  browserCount?: number;
}

interface GEdge {
  source: string;
  target: string;
  connected: boolean;
}

interface AwarenessPeer {
  name: string;
  color: string;
}

// d3 simulation node
interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
}

// ── Constants ────────────────────────────────────

const W = 400;
const H = 300;
const CX = W / 2;
const CY = H / 2;

const C = {
  self: "#10b981",
  selfGlow: "rgba(16,185,129,0.25)",
  relay: "#3b82f6",
  pinner: "#f59e0b",
  "relay+pinner": "#8b5cf6",
  browser: "#94a3b8",
  browserFill: "rgba(148,163,184,0.15)",
  edge: "#cbd5e1",
  edgeDash: "#e2e8f0",
  disconnected: "#e2e8f0",
  disconnectedStroke: "#d1d5db",
  guaranteeActive: "#22c55e",
  guaranteeExpired: "#ef4444",
  particle: "#fbbf24",
  ack: "#22c55e",
} as const;

function nodeR(kind: NodeKind): number {
  switch (kind) {
    case "self": return 22;
    case "browser": return 9;
    default: return 16;
  }
}

// ── Build graph from Diagnostics ─────────────────

function nodeKind(roles: string[]): NodeKind {
  const p = roles.includes("pinner");
  const r = roles.includes("relay");
  if (p && r) return "relay+pinner";
  if (p) return "pinner";
  if (r) return "relay";
  return "browser";
}

function buildGraph(
  info: Diagnostics,
  peers: AwarenessPeer[],
): { nodes: GNode[]; edges: GEdge[] } {
  const now = Date.now();
  const nodes: GNode[] = [{
    id: "_self",
    label: "You",
    kind: "self",
    connected: true,
    ackedCurrentCid: false,
  }];
  const edges: GEdge[] = [];

  for (const n of info.nodes) {
    const kind = nodeKind(n.roles);
    let guaranteeLabel: string | undefined;
    let guaranteeActive: boolean | undefined;
    if (
      n.ackedCurrentCid &&
      kind !== "relay" &&
      info.guaranteeUntil != null
    ) {
      guaranteeActive = info.guaranteeUntil > now;
      guaranteeLabel = guaranteeActive
        ? formatRelativeTime(info.guaranteeUntil)
        : "expired";
    }
    nodes.push({
      id: n.peerId,
      label: `…${n.short}`,
      kind,
      connected: n.connected,
      ackedCurrentCid: n.ackedCurrentCid,
      guaranteeLabel,
      guaranteeActive,
      browserCount: n.browserCount,
    });
    edges.push({
      source: "_self",
      target: n.peerId,
      connected: n.connected,
    });
  }

  for (const te of info.topology) {
    const dup = edges.some(
      (e) =>
        (e.source === te.source &&
          e.target === te.target) ||
        (e.source === te.target &&
          e.target === te.source),
    );
    if (!dup) {
      edges.push({
        source: te.source,
        target: te.target,
        connected: true,
      });
    }
  }

  if (peers.length > 0) {
    nodes.push({
      id: "_peers",
      label:
        peers.length === 1
          ? peers[0].name || "Anonymous"
          : `${peers.length} peers`,
      kind: "browser",
      connected: true,
      ackedCurrentCid: false,
      browserCount: peers.length,
    });
    edges.push({
      source: "_self",
      target: "_peers",
      connected: true,
    });
  }

  return { nodes, edges };
}

// Fingerprint for detecting structural changes
function graphFp(
  nodes: GNode[],
  edges: GEdge[],
): string {
  return (
    nodes
      .map(
        (n) =>
          `${n.id}:${n.kind}:${n.connected}` +
          `:${n.ackedCurrentCid}`,
      )
      .sort()
      .join("|") +
    "||" +
    edges
      .map(
        (e) =>
          `${e.source}-${e.target}:${e.connected}`,
      )
      .sort()
      .join("|")
  );
}

// ── Force layout hook ────────────────────────────

function useForceLayout(
  nodes: GNode[],
  edges: GEdge[],
): Map<string, { x: number; y: number }> {
  type Sim = Simulation<SimNode, undefined>;
  const simRef = useRef<Sim | null>(null);
  const prevRef = useRef<SimNode[]>([]);
  const [posMap, setPosMap] = useState<
    Map<string, { x: number; y: number }>
  >(() => new Map());

  useEffect(() => {
    const prev = new Map(
      prevRef.current.map((n) => [n.id, n]),
    );

    const simNodes: SimNode[] = nodes.map((n) => {
      const p = prev.get(n.id);
      return {
        id: n.id,
        kind: n.kind,
        x: p?.x ?? CX + (Math.random() - 0.5) * 80,
        y: p?.y ?? CY + (Math.random() - 0.5) * 60,
        vx: p?.vx ?? 0,
        vy: p?.vy ?? 0,
        fx: n.kind === "self" ? CX : undefined,
        fy: n.kind === "self" ? CY : undefined,
      };
    });
    prevRef.current = simNodes;

    const byId = new Map(
      simNodes.map((n) => [n.id, n]),
    );
    const links = edges
      .filter(
        (e) =>
          byId.has(e.source) && byId.has(e.target),
      )
      .map((e) => ({
        source: e.source,
        target: e.target,
      }));

    simRef.current?.stop();

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink(links)
          .id((d: any) => d.id)
          .distance((l: any) => {
            const s = l.source as SimNode;
            const t = l.target as SimNode;
            if (
              s.kind === "self" ||
              t.kind === "self"
            ) {
              const o =
                s.kind === "self" ? t : s;
              return o.kind === "browser" ? 50 : 100;
            }
            return 70;
          })
          .strength(0.7),
      )
      .force(
        "charge",
        forceManyBody<SimNode>().strength((d) => {
          switch (d.kind) {
            case "self": return -350;
            case "browser": return -50;
            default: return -220;
          }
        }),
      )
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((d) => nodeR(d.kind) + 12)
          .strength(0.8),
      )
      .force("x", forceX(CX).strength(0.04))
      .force("y", forceY(CY).strength(0.04))
      .alpha(0.6)
      .alphaDecay(0.025)
      .on("tick", () => {
        const m = new Map<
          string,
          { x: number; y: number }
        >();
        for (const n of simNodes) {
          m.set(n.id, {
            x: Math.max(
              30, Math.min(W - 30, n.x!),
            ),
            y: Math.max(
              30, Math.min(H - 30, n.y!),
            ),
          });
        }
        setPosMap(m);
      });

    simRef.current = sim;
    return () => { sim.stop(); };
  }, [nodes, edges]);

  return posMap;
}

// ── Particle animation (imperative SVG) ──────────

function useParticles(
  groupRef: React.RefObject<SVGGElement | null>,
  pulseKey: number,
  edges: GEdge[],
  posMap: Map<string, { x: number; y: number }>,
) {
  const rafRef = useRef(0);

  useEffect(() => {
    const g = groupRef.current;
    if (!g || pulseKey === 0 || posMap.size === 0) {
      return;
    }

    interface P {
      el: SVGCircleElement;
      x1: number; y1: number;
      x2: number; y2: number;
      born: number;
      dur: number;
    }
    const particles: P[] = [];
    const ns =
      "http://www.w3.org/2000/svg";

    for (const e of edges) {
      if (!e.connected) continue;
      const s = posMap.get(e.source);
      const t = posMap.get(e.target);
      if (!s || !t) continue;
      const count =
        2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) {
        const el = document.createElementNS(
          ns, "circle",
        );
        el.setAttribute("r", "2.5");
        el.setAttribute("fill", C.particle);
        el.setAttribute("opacity", "0");
        g.appendChild(el);
        particles.push({
          el,
          x1: s.x, y1: s.y,
          x2: t.x, y2: t.y,
          born: performance.now() + i * 120,
          dur: 700 + Math.random() * 500,
        });
      }
    }

    const tick = (now: number) => {
      let alive = 0;
      for (const p of particles) {
        if (now < p.born) { alive++; continue; }
        const t = (now - p.born) / p.dur;
        if (t >= 1) {
          p.el.remove();
          continue;
        }
        alive++;
        const ease = 1 - (1 - t) ** 2;
        p.el.setAttribute(
          "cx", String(
            p.x1 + (p.x2 - p.x1) * ease,
          ),
        );
        p.el.setAttribute(
          "cy", String(
            p.y1 + (p.y2 - p.y1) * ease,
          ),
        );
        p.el.setAttribute(
          "opacity",
          String(t < 0.7 ? 0.85 : (1 - t) / 0.3),
        );
      }
      if (alive > 0) {
        rafRef.current =
          requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      for (const p of particles) p.el.remove();
    };
  }, [pulseKey, groupRef]);
}

// ── SVG shapes ───────────────────────────────────

function hexPoints(r: number): string {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(
      `${r * Math.cos(a)},${r * Math.sin(a)}`,
    );
  }
  return pts.join(" ");
}

function NodeShape({
  node,
  x,
  y,
  onHover,
}: {
  node: GNode;
  x: number;
  y: number;
  onHover: (
    n: GNode | null,
    e?: React.MouseEvent,
  ) => void;
}) {
  const r = nodeR(node.kind);
  const off = !node.connected &&
    node.kind !== "self";
  const op = off ? 0.4 : 1;

  const handleEnter = useCallback(
    (e: React.MouseEvent) => onHover(node, e),
    [node, onHover],
  );
  const handleLeave = useCallback(
    () => onHover(null),
    [onHover],
  );

  // Build tooltip
  const tip = [node.label];
  if (
    node.kind !== "self" &&
    node.kind !== "browser"
  ) {
    tip.push(`(${node.kind})`);
  }
  if (node.ackedCurrentCid) tip.push("— acked");
  if (node.guaranteeLabel) {
    tip.push(
      node.guaranteeActive
        ? `— pinned ${node.guaranteeLabel}`
        : "— guarantee expired",
    );
  }
  if (off) tip.push("— disconnected");

  let shape: React.ReactNode;

  if (node.kind === "self") {
    shape = (
      <>
        {/* Glow */}
        <circle
          cx={0} cy={0} r={r + 8}
          fill={C.selfGlow}
        />
        <circle
          cx={0} cy={0} r={r}
          fill={C.self}
          stroke="#fff"
          strokeWidth={2.5}
        />
      </>
    );
  } else if (node.kind === "relay") {
    const hw = r * 1.2;
    const hh = r * 0.85;
    shape = (
      <rect
        x={-hw} y={-hh}
        width={hw * 2} height={hh * 2}
        rx={4}
        fill={off ? C.disconnected : C.relay}
        stroke={
          off ? C.disconnectedStroke : "#2563eb"
        }
        strokeWidth={off ? 1 : 2}
        opacity={op}
      />
    );
  } else if (node.kind === "pinner") {
    shape = (
      <polygon
        points={hexPoints(r + 2)}
        fill={off ? C.disconnected : C.pinner}
        stroke={
          off ? C.disconnectedStroke : "#d97706"
        }
        strokeWidth={off ? 1 : 2}
        strokeLinejoin="round"
        opacity={op}
      />
    );
  } else if (node.kind === "relay+pinner") {
    // Composite: hex inside rounded rect
    const hw = r * 1.3;
    const hh = r * 0.95;
    shape = (
      <>
        <rect
          x={-hw} y={-hh}
          width={hw * 2} height={hh * 2}
          rx={4}
          fill="none"
          stroke={off ? C.disconnectedStroke : C.relay}
          strokeWidth={1.5}
          opacity={op}
        />
        <polygon
          points={hexPoints(r)}
          fill={
            off
              ? C.disconnected
              : C["relay+pinner"]
          }
          stroke={
            off ? C.disconnectedStroke : "#7c3aed"
          }
          strokeWidth={1.5}
          strokeLinejoin="round"
          opacity={op}
        />
      </>
    );
  } else {
    // Browser peer — small and ephemeral
    shape = (
      <circle
        cx={0} cy={0} r={r}
        fill={C.browserFill}
        stroke={C.browser}
        strokeWidth={1}
        strokeDasharray={off ? "2 2" : "none"}
        opacity={off ? 0.3 : 0.7}
      />
    );
  }

  // Inner label
  let label = "";
  if (node.kind === "self") {
    label = "You";
  } else if (node.kind === "browser") {
    label =
      node.browserCount && node.browserCount > 1
        ? String(node.browserCount)
        : "";
  } else if (node.kind === "relay") {
    label = "R";
  } else if (node.kind === "pinner") {
    label = "P";
  } else {
    label = "RP";
  }

  return (
    <g
      transform={`translate(${x},${y})`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ cursor: "default" }}
    >
      <title>{tip.join(" ")}</title>

      {/* Guarantee ring */}
      {node.guaranteeLabel && (
        <circle
          cx={0} cy={0}
          r={r + 6}
          fill="none"
          stroke={
            node.guaranteeActive
              ? C.guaranteeActive
              : C.guaranteeExpired
          }
          strokeWidth={node.guaranteeActive ? 2.5 : 1.5}
          strokeDasharray={
            node.guaranteeActive ? "none" : "3 2"
          }
          className={
            node.guaranteeActive
              ? "topo-guarantee-pulse"
              : "topo-guarantee-fade"
          }
        />
      )}

      {shape}

      {/* Label */}
      {label && (
        <text
          x={0} y={1}
          textAnchor="middle"
          dominantBaseline="central"
          className={
            node.kind === "self"
              ? "topo-label-self"
              : node.kind === "browser"
                ? "topo-label-peer"
                : "topo-label-infra"
          }
        >
          {label}
        </text>
      )}

      {/* Ack badge */}
      {node.ackedCurrentCid && (
        <g transform={`translate(${r - 2},${-r + 2})`}>
          <circle
            r={5}
            fill={C.ack}
            stroke="#fff"
            strokeWidth={1}
          />
          <text
            x={0} y={0.5}
            textAnchor="middle"
            dominantBaseline="central"
            className="topo-ack-text"
          >
            ✓
          </text>
        </g>
      )}

      {/* Browser count badge on infra nodes */}
      {node.kind !== "self" &&
        node.kind !== "browser" &&
        node.browserCount != null &&
        node.browserCount > 0 && (
        <g transform={`translate(${r + 1},${r - 2})`}>
          <circle
            r={6}
            fill="#059669"
            stroke="#fff"
            strokeWidth={1}
          />
          <text
            x={0} y={0.5}
            textAnchor="middle"
            dominantBaseline="central"
            className="topo-badge-text"
          >
            {node.browserCount}
          </text>
        </g>
      )}

      {/* Peer ID below */}
      {node.kind !== "self" && (
        <text
          x={0}
          y={r + (node.kind === "browser" ? 5 : 12)}
          textAnchor="middle"
          className="topo-peer-id"
        >
          {node.label}
        </text>
      )}

      {/* Guarantee time below peer ID */}
      {node.guaranteeLabel && (
        <text
          x={0}
          y={r + 21}
          textAnchor="middle"
          className={
            node.guaranteeActive
              ? "topo-guarantee-label"
              : "topo-guarantee-label expired"
          }
        >
          {node.guaranteeActive
            ? `pinned ${node.guaranteeLabel}`
            : "expired"}
        </text>
      )}
    </g>
  );
}

// ── Edge rendering ───────────────────────────────

function EdgeLine({
  x1, y1, x2, y2, connected,
}: {
  x1: number; y1: number;
  x2: number; y2: number;
  connected: boolean;
}) {
  return (
    <line
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={connected ? C.edge : C.edgeDash}
      strokeWidth={connected ? 1.2 : 0.8}
      strokeDasharray={connected ? "none" : "4 3"}
      strokeOpacity={connected ? 0.5 : 0.25}
    />
  );
}

// ── Tooltip ──────────────────────────────────────

function Tooltip({
  node,
  svgRect,
  mouseX,
  mouseY,
}: {
  node: GNode;
  svgRect: DOMRect;
  mouseX: number;
  mouseY: number;
}) {
  const left = mouseX - svgRect.left + 12;
  const top = mouseY - svgRect.top - 10;

  return (
    <div
      className="topo-tooltip"
      style={{ left, top }}
    >
      <div className="topo-tooltip-kind">
        {node.kind === "self"
          ? "You (this browser)"
          : node.kind === "browser"
            ? "Browser peer"
            : node.kind}
      </div>
      {node.kind !== "self" && (
        <div className="topo-tooltip-id">
          {node.label}
        </div>
      )}
      {node.kind !== "self" &&
        node.kind !== "browser" && (
        <div className="topo-tooltip-status">
          {node.connected
            ? "Connected"
            : "Disconnected"}
        </div>
      )}
      {node.browserCount != null &&
        node.browserCount > 0 && (
        <div className="topo-tooltip-detail">
          {node.browserCount} browser
          {node.browserCount > 1 ? "s" : ""}{" "}
          connected
        </div>
      )}
      {node.ackedCurrentCid && (
        <div className="topo-tooltip-ack">
          Acked current snapshot
        </div>
      )}
      {node.guaranteeLabel && (
        <div
          className={
            "topo-tooltip-guarantee" +
            (node.guaranteeActive
              ? " active" : " expired")
          }
        >
          {node.guaranteeActive
            ? `Pinned for ${node.guaranteeLabel}`
            : "Guarantee expired"}
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────

export function TopologyMap({
  info,
  awarenessPeers,
  pulseKey,
}: {
  info: Diagnostics;
  awarenessPeers: AwarenessPeer[];
  pulseKey: number;
}) {
  // Debounce graph updates; immediate on structure
  // change, 8s delay otherwise
  const [graph, setGraph] = useState(() =>
    buildGraph(info, awarenessPeers),
  );
  const prevFpRef = useRef("");
  const debounceRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    const g = buildGraph(info, awarenessPeers);
    const fp = graphFp(g.nodes, g.edges);

    if (fp !== prevFpRef.current) {
      // Structural change — update immediately
      prevFpRef.current = fp;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      setGraph(g);
    } else {
      // Data-only change — debounce
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        setGraph(g);
      }, 8_000);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [info, awarenessPeers]);

  const posMap = useForceLayout(
    graph.nodes,
    graph.edges,
  );

  // Particle animation
  const particleRef = useRef<SVGGElement | null>(
    null,
  );
  useParticles(
    particleRef,
    pulseKey,
    graph.edges,
    posMap,
  );

  // Tooltip state
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<{
    node: GNode;
    mx: number;
    my: number;
  } | null>(null);

  const onHover = useCallback(
    (n: GNode | null, e?: React.MouseEvent) => {
      if (n && e) {
        setHovered({
          node: n,
          mx: e.clientX,
          my: e.clientY,
        });
      } else {
        setHovered(null);
      }
    },
    [],
  );

  // Render order: edges, particles, nodes
  // Nodes sorted: browsers first, then infra, self
  // last (on top)
  const sorted = graph.nodes.slice().sort((a, b) => {
    const order = (k: NodeKind) => {
      switch (k) {
        case "browser": return 0;
        case "relay":
        case "pinner":
        case "relay+pinner": return 1;
        case "self": return 2;
      }
    };
    return order(a.kind) - order(b.kind);
  });

  return (
    <div className="topo-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="topo-svg"
        aria-label="Network topology"
      >
        {/* Edges */}
        {graph.edges.map((e) => {
          const s = posMap.get(e.source);
          const t = posMap.get(e.target);
          if (!s || !t) return null;
          return (
            <EdgeLine
              key={`${e.source}-${e.target}`}
              x1={s.x} y1={s.y}
              x2={t.x} y2={t.y}
              connected={e.connected}
            />
          );
        })}

        {/* Particle layer */}
        <g ref={particleRef} />

        {/* Nodes */}
        {sorted.map((n) => {
          const p = posMap.get(n.id);
          if (!p) return null;
          return (
            <NodeShape
              key={n.id}
              node={n}
              x={p.x}
              y={p.y}
              onHover={onHover}
            />
          );
        })}
      </svg>

      {/* HTML tooltip overlay */}
      {hovered && svgRef.current && (
        <Tooltip
          node={hovered.node}
          svgRect={
            svgRef.current.getBoundingClientRect()
          }
          mouseX={hovered.mx}
          mouseY={hovered.my}
        />
      )}
    </div>
  );
}
