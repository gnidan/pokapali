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
import type {
  TopologyNode,
  TopologyGraphEdge,
  TopologyGraph,
  Diagnostics,
} from "@pokapali/core";
import { formatRelativeTime } from "./ConnectionStatus";

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

function nodeR(kind: TopologyNode["kind"]): number {
  switch (kind) {
    case "self": return 22;
    case "browser": return 9;
    default: return 16;
  }
}

// ── Fingerprint for detecting structural changes ─

function graphFp(graph: TopologyGraph): string {
  return (
    graph.nodes
      .map(
        (n) =>
          `${n.id}:${n.kind}:${n.connected}` +
          `:${n.ackedCurrentCid ?? ""}`,
      )
      .sort()
      .join("|") +
    "||" +
    graph.edges
      .map(
        (e) =>
          `${e.source}-${e.target}` +
          `:${e.connected}`,
      )
      .sort()
      .join("|")
  );
}

// ── Force layout hook ────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: TopologyNode["kind"];
}

function useForceLayout(
  graph: TopologyGraph,
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

    const simNodes: SimNode[] =
      graph.nodes.map((n) => {
        const p = prev.get(n.id);
        return {
          id: n.id,
          kind: n.kind,
          x: p?.x ??
            CX + (Math.random() - 0.5) * 80,
          y: p?.y ??
            CY + (Math.random() - 0.5) * 60,
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
    const links = graph.edges
      .filter(
        (e) =>
          byId.has(e.source) &&
          byId.has(e.target),
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
              return o.kind === "browser"
                ? 50 : 100;
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
  }, [graph]);

  return posMap;
}

// ── Particle animation (imperative SVG) ──────────

function useParticles(
  groupRef: React.RefObject<SVGGElement | null>,
  pulseKey: number,
  edges: TopologyGraphEdge[],
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
    const ns = "http://www.w3.org/2000/svg";

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
          String(
            t < 0.7 ? 0.85 : (1 - t) / 0.3,
          ),
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
  guaranteeUntil,
  onHover,
}: {
  node: TopologyNode;
  x: number;
  y: number;
  guaranteeUntil: number | null;
  onHover: (
    n: TopologyNode | null,
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

  // Guarantee state for acked pinners
  const now = Date.now();
  const hasPinnerRole =
    node.kind === "pinner" ||
    node.kind === "relay+pinner";
  const showGuarantee =
    hasPinnerRole &&
    node.ackedCurrentCid &&
    guaranteeUntil != null;
  const guaranteeActive = showGuarantee
    ? guaranteeUntil > now
    : false;
  const guaranteeLabel = showGuarantee
    ? (guaranteeActive
        ? formatRelativeTime(guaranteeUntil)
        : "expired")
    : undefined;

  // Build tooltip
  const tip = [node.label];
  if (
    node.kind !== "self" &&
    node.kind !== "browser"
  ) {
    tip.push(`(${node.kind})`);
  }
  if (node.ackedCurrentCid) tip.push("— acked");
  if (guaranteeLabel) {
    tip.push(
      guaranteeActive
        ? `— pinned ${guaranteeLabel}`
        : "— guarantee expired",
    );
  }
  if (off) tip.push("— disconnected");

  let shape: React.ReactNode;

  if (node.kind === "self") {
    shape = (
      <>
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
    const hw = r * 1.3;
    const hh = r * 0.95;
    shape = (
      <>
        <rect
          x={-hw} y={-hh}
          width={hw * 2} height={hh * 2}
          rx={4}
          fill="none"
          stroke={
            off ? C.disconnectedStroke : C.relay
          }
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
            off
              ? C.disconnectedStroke
              : "#7c3aed"
          }
          strokeWidth={1.5}
          strokeLinejoin="round"
          opacity={op}
        />
      </>
    );
  } else {
    // Browser peer
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
    // No label for browser peers (name shown below)
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
      {showGuarantee && (
        <circle
          cx={0} cy={0}
          r={r + 6}
          fill="none"
          stroke={
            guaranteeActive
              ? C.guaranteeActive
              : C.guaranteeExpired
          }
          strokeWidth={
            guaranteeActive ? 2.5 : 1.5
          }
          strokeDasharray={
            guaranteeActive ? "none" : "3 2"
          }
          className={
            guaranteeActive
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
              : "topo-label-infra"
          }
        >
          {label}
        </text>
      )}

      {/* Ack badge */}
      {node.ackedCurrentCid && (
        <g
          transform={
            `translate(${r - 2},${-r + 2})`
          }
        >
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
        <g
          transform={
            `translate(${r + 1},${r - 2})`
          }
        >
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

      {/* Peer ID / name below */}
      {node.kind !== "self" && (
        <text
          x={0}
          y={
            r +
            (node.kind === "browser" ? 5 : 12)
          }
          textAnchor="middle"
          className="topo-peer-id"
        >
          {node.label}
        </text>
      )}

      {/* Guarantee time below peer ID */}
      {guaranteeLabel && (
        <text
          x={0}
          y={r + 21}
          textAnchor="middle"
          className={
            guaranteeActive
              ? "topo-guarantee-label"
              : "topo-guarantee-label expired"
          }
        >
          {guaranteeActive
            ? `pinned ${guaranteeLabel}`
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
      strokeDasharray={
        connected ? "none" : "4 3"
      }
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
  guaranteeUntil,
}: {
  node: TopologyNode;
  svgRect: DOMRect;
  mouseX: number;
  mouseY: number;
  guaranteeUntil: number | null;
}) {
  const left = mouseX - svgRect.left + 12;
  const top = mouseY - svgRect.top - 10;

  const hasPinner =
    node.kind === "pinner" ||
    node.kind === "relay+pinner";
  const now = Date.now();
  const gActive =
    hasPinner &&
    node.ackedCurrentCid &&
    guaranteeUntil != null &&
    guaranteeUntil > now;
  const gExpired =
    hasPinner &&
    node.ackedCurrentCid &&
    guaranteeUntil != null &&
    guaranteeUntil <= now;

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
      {gActive && (
        <div className="topo-tooltip-guarantee active">
          Pinned for{" "}
          {formatRelativeTime(guaranteeUntil!)}
        </div>
      )}
      {gExpired && (
        <div className="topo-tooltip-guarantee expired">
          Guarantee expired
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────

export function TopologyMap({
  doc,
  pulseKey,
}: {
  doc: {
    topologyGraph(): TopologyGraph;
    diagnostics(): Diagnostics;
  };
  pulseKey: number;
}) {
  // Build graph from core's merged topology API
  const [graph, setGraph] = useState<TopologyGraph>(
    () => doc.topologyGraph(),
  );
  const [guaranteeUntil, setGuaranteeUntil] =
    useState<number | null>(
      () => doc.diagnostics().guaranteeUntil,
    );
  const prevFpRef = useRef("");
  const debounceRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    const g = doc.topologyGraph();
    const fp = graphFp(g);
    const gu = doc.diagnostics().guaranteeUntil;

    if (fp !== prevFpRef.current) {
      prevFpRef.current = fp;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      setGraph(g);
      setGuaranteeUntil(gu);
    } else {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        setGraph(g);
        setGuaranteeUntil(gu);
      }, 8_000);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [doc, pulseKey]);

  const posMap = useForceLayout(graph);

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
    node: TopologyNode;
    mx: number;
    my: number;
  } | null>(null);

  const onHover = useCallback(
    (
      n: TopologyNode | null,
      e?: React.MouseEvent,
    ) => {
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

  // Render order: browsers, infra, self on top
  const sorted = graph.nodes.slice().sort(
    (a, b) => {
      const order = (
        k: TopologyNode["kind"],
      ) => {
        switch (k) {
          case "browser": return 0;
          case "relay":
          case "pinner":
          case "relay+pinner": return 1;
          case "self": return 2;
        }
      };
      return order(a.kind) - order(b.kind);
    },
  );

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
              guaranteeUntil={guaranteeUntil}
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
          guaranteeUntil={guaranteeUntil}
        />
      )}
    </div>
  );
}
