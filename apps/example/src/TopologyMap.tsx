import { useState, useEffect, useRef, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from "d3-force";
import type { Simulation, SimulationNodeDatum } from "d3-force";
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
const NODE_R = 15;
const SELF_R = 20;

const C = {
  self: "#10b981",
  selfGlow: "rgba(16,185,129,0.25)",
  node: "#475569",
  nodeFill: "#f8fafc",
  nodeStroke: "#94a3b8",
  browser: "#64748b",
  browserFill: "#f1f5f9",
  edge: "#cbd5e1",
  edgeDash: "#e2e8f0",
  disconnected: "#e2e8f0",
  disconnectedStroke: "#d1d5db",
  relay: "#3b82f6",
  pinner: "#f59e0b",
  pinnerAcked: "#22c55e",
  pinnerExpired: "#ef4444",
  guaranteeActive: "#22c55e",
  guaranteeExpired: "#ef4444",
  dual: "#8b5cf6",
  particle: "#fbbf24",
} as const;

// ── Fingerprint for structural changes ───────────

function graphFp(graph: TopologyGraph): string {
  return (
    graph.nodes
      .map(
        (n) =>
          `${n.id}:${n.kind}:${n.connected}` + `:${n.ackedCurrentCid ?? ""}`,
      )
      .sort()
      .join("|") +
    "||" +
    graph.edges
      .map((e) => `${e.source}-${e.target}` + `:${e.connected}`)
      .sort()
      .join("|")
  );
}

// ── Force layout hook ────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: TopologyNode["kind"];
}

const isInfra = (k: TopologyNode["kind"]) =>
  k === "relay" || k === "pinner" || k === "relay+pinner";

function linkDistanceFn(l: { source: SimNode; target: SimNode }): number {
  const s = l.source;
  const t = l.target;
  if (isInfra(s.kind) && isInfra(t.kind)) {
    return 40;
  }
  if (s.kind === "self" || t.kind === "self") {
    return 60;
  }
  return 110;
}

function linkStrengthFn(l: { source: SimNode; target: SimNode }): number {
  const s = l.source;
  const t = l.target;
  if (isInfra(s.kind) && isInfra(t.kind)) {
    return 0.9;
  }
  if (s.kind === "browser" || t.kind === "browser") {
    return 0.15;
  }
  return 0.7;
}

function chargeFn(d: SimNode): number {
  switch (d.kind) {
    case "self":
      return -350;
    case "browser":
      return -150;
    default:
      return -120;
  }
}

function centerStrength(d: SimNode): number {
  return isInfra(d.kind) ? 0.12 : 0.03;
}

function useForceLayout(
  graph: TopologyGraph,
): Map<string, { x: number; y: number }> {
  type Sim = Simulation<SimNode, undefined>;
  const simRef = useRef<Sim | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const [posMap, setPosMap] = useState<Map<string, { x: number; y: number }>>(
    () => new Map(),
  );

  // One-time simulation creation
  useEffect(() => {
    const tick = () => {
      const m = new Map<string, { x: number; y: number }>();
      // Read live ref — nodes array is replaced
      // on each graph update
      for (const n of nodesRef.current) {
        m.set(n.id, {
          x: Math.max(30, Math.min(W - 30, n.x)),
          y: Math.max(30, Math.min(H - 30, n.y)),
        });
      }
      setPosMap(m);
    };

    const sim = forceSimulation<SimNode>(nodesRef.current)
      .force(
        "link",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (forceLink as any)([])
          .id((d: SimNode) => d.id)
          .distance(linkDistanceFn)
          .strength(linkStrengthFn),
      )
      .force("charge", forceManyBody<SimNode>().strength(chargeFn))
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((d) => (d.kind === "self" ? SELF_R : NODE_R) + 12)
          .strength(0.8),
      )
      .force("x", forceX<SimNode>(CX).strength(centerStrength))
      .force("y", forceY<SimNode>(CY).strength(centerStrength))
      .alphaDecay(0.025)
      .on("tick", tick);

    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, []);

  // Incremental update on graph change
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;

    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nextIds = new Set(graph.nodes.map((n) => n.id));

    // Update existing + add new nodes
    const nodes: SimNode[] = graph.nodes.map((n) => {
      const existing = prev.get(n.id);
      if (existing) {
        // Update mutable properties in place
        existing.kind = n.kind;
        existing.fx = n.kind === "self" ? CX : undefined;
        existing.fy = n.kind === "self" ? CY : undefined;
        return existing;
      }
      // New node — position near center
      return {
        id: n.id,
        kind: n.kind,
        x: CX + (Math.random() - 0.5) * 80,
        y: CY + (Math.random() - 0.5) * 60,
        vx: 0,
        vy: 0,
        fx: n.kind === "self" ? CX : undefined,
        fy: n.kind === "self" ? CY : undefined,
      };
    });
    nodesRef.current = nodes;

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = graph.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
      }));

    // Push updated arrays into the simulation
    sim.nodes(nodes);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sim.force("link") as any)?.links(links);

    // Structural change (nodes added/removed):
    // moderate reheat. Data-only change: gentle.
    const structural =
      nextIds.size !== prev.size || [...nextIds].some((id) => !prev.has(id));
    sim.alpha(structural ? 0.3 : 0.08).restart();
  }, [graph]);

  return posMap;
}

// ── Particle animation (imperative, topology-safe)

function useParticles(
  groupRef: React.RefObject<SVGGElement | null>,
  pulseKey: number,
  edges: TopologyGraphEdge[],
  posMapRef: React.RefObject<Map<string, { x: number; y: number }>>,
) {
  const rafRef = useRef(0);

  useEffect(() => {
    const g = groupRef.current;
    const posMap = posMapRef.current;
    if (!g || pulseKey === 0 || posMap.size === 0) {
      return;
    }

    interface P {
      el: SVGCircleElement;
      srcId: string;
      tgtId: string;
      born: number;
      dur: number;
    }
    const particles: P[] = [];
    const ns = "http://www.w3.org/2000/svg";

    for (const e of edges) {
      if (!e.connected) continue;
      // Only animate edges involving _self —
      // we only observe our own send/receive.
      if (e.source !== "_self" && e.target !== "_self") continue;
      if (!posMap.has(e.source)) continue;
      if (!posMap.has(e.target)) continue;
      // Bidirectional: spawn particles both ways
      const dirs = [
        [e.source, e.target],
        [e.target, e.source],
      ] as const;
      for (const [src, tgt] of dirs) {
        const count = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < count; i++) {
          const el = document.createElementNS(ns, "circle");
          el.setAttribute("r", "2.5");
          el.setAttribute("fill", C.particle);
          el.setAttribute("opacity", "0");
          g.appendChild(el);
          particles.push({
            el,
            srcId: src,
            tgtId: tgt,
            born: performance.now() + i * 150 + Math.random() * 100,
            dur: 700 + Math.random() * 500,
          });
        }
      }
    }

    const tick = (now: number) => {
      const pm = posMapRef.current;
      let alive = 0;
      for (const p of particles) {
        if (now < p.born) {
          alive++;
          continue;
        }
        const t = (now - p.born) / p.dur;
        if (t >= 1) {
          p.el.remove();
          continue;
        }
        // Look up current positions (safe if
        // topology changed mid-animation)
        const s = pm.get(p.srcId);
        const d = pm.get(p.tgtId);
        if (!s || !d) {
          p.el.remove();
          continue;
        }
        alive++;
        const ease = 1 - (1 - t) ** 2;
        p.el.setAttribute("cx", String(s.x + (d.x - s.x) * ease));
        p.el.setAttribute("cy", String(s.y + (d.y - s.y) * ease));
        p.el.setAttribute("opacity", String(t < 0.7 ? 0.85 : (1 - t) / 0.3));
      }
      if (alive > 0) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      for (const p of particles) p.el.remove();
    };
  }, [pulseKey, groupRef, posMapRef]);
}

// ── Person silhouette for anonymous browsers ─────

function PersonIcon() {
  // Simple head + shoulders silhouette
  return (
    <g opacity={0.5}>
      <circle cx={0} cy={-2} r={4} fill="#64748b" />
      <path d="M-6,7 Q-6,2 0,2 Q6,2 6,7" fill="#64748b" />
    </g>
  );
}

// ── Browser label helpers ────────────────────────

function browserAbbrev(label: string): string {
  const name = label.replace(/^…/, "").trim();
  if (!name || name === "Anonymous") return "";
  // Use first two characters, capitalized
  return name.slice(0, 2).toUpperCase();
}

// ── Node rendering ───────────────────────────────

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
  onHover: (n: TopologyNode | null, e?: React.MouseEvent) => void;
}) {
  const isSelf = node.kind === "self";
  const r = isSelf ? SELF_R : NODE_R;
  const off = !node.connected && !isSelf;

  const handleEnter = useCallback(
    (e: React.MouseEvent) => onHover(node, e),
    [node, onHover],
  );
  const handleLeave = useCallback(() => onHover(null), [onHover]);

  // Determine roles
  const isRelay = node.kind === "relay" || node.kind === "relay+pinner";
  const isPinner = node.kind === "pinner" || node.kind === "relay+pinner";
  const isBrowser = node.kind === "browser";

  // Guarantee state
  const now = Date.now();
  const showGuarantee =
    isPinner && node.ackedCurrentCid && guaranteeUntil != null;
  const guaranteeActive = showGuarantee ? guaranteeUntil > now : false;

  // Role ring color (primary visual identifier)
  let roleStroke: string;
  let roleStrokeW: number;
  if (isSelf) {
    roleStroke = "#fff";
    roleStrokeW = 2.5;
  } else if (off) {
    roleStroke = C.disconnectedStroke;
    roleStrokeW = 1.5;
  } else if (node.kind === "relay") {
    roleStroke = C.relay;
    roleStrokeW = 2.5;
  } else if (node.kind === "pinner") {
    roleStroke = C.pinner;
    roleStrokeW = 2.5;
  } else if (node.kind === "relay+pinner") {
    roleStroke = C.dual;
    roleStrokeW = 3;
  } else if (isBrowser) {
    roleStroke = C.browser;
    roleStrokeW = 1.5;
  } else {
    roleStroke = C.nodeStroke;
    roleStrokeW = 2;
  }

  // Circle fill
  let fill: string;
  if (isSelf) {
    fill = C.self;
  } else if (off) {
    fill = C.disconnected;
  } else if (isBrowser) {
    fill = C.browserFill;
  } else {
    fill = C.nodeFill;
  }

  // Inner label
  let label = "";
  if (isSelf) {
    label = "You";
  } else if (isBrowser) {
    label = browserAbbrev(node.label);
  } else if (node.kind === "relay") {
    label = "R";
  } else if (node.kind === "pinner") {
    label = "P";
  } else if (node.kind === "relay+pinner") {
    label = "RP";
  }

  // Build tooltip
  const tip = [node.label];
  if (!isSelf && !isBrowser) {
    tip.push(`(${node.kind})`);
  }
  if (node.ackedCurrentCid) tip.push("— acked");
  if (showGuarantee) {
    tip.push(
      guaranteeActive
        ? `— pinned ${formatRelativeTime(guaranteeUntil)}`
        : "— guarantee expired",
    );
  }
  if (off) tip.push("— disconnected");

  return (
    <g
      transform={`translate(${x},${y})`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ cursor: "default" }}
    >
      <title>{tip.join(" ")}</title>

      {/* Pulsing guarantee halo */}
      {showGuarantee && (
        <circle
          cx={0}
          cy={0}
          r={r + 6}
          fill="none"
          stroke={guaranteeActive ? C.guaranteeActive : C.guaranteeExpired}
          strokeWidth={guaranteeActive ? 2.5 : 1.5}
          strokeDasharray={guaranteeActive ? "none" : "3 2"}
          className={
            guaranteeActive ? "topo-guarantee-pulse" : "topo-guarantee-fade"
          }
        />
      )}

      {/* Self glow */}
      {isSelf && <circle cx={0} cy={0} r={r + 8} fill={C.selfGlow} />}

      {/* Main circle — colored ring = role */}
      <circle
        cx={0}
        cy={0}
        r={r}
        fill={fill}
        stroke={roleStroke}
        strokeWidth={roleStrokeW}
        strokeDasharray={off ? "3 2" : "none"}
        opacity={off ? 0.5 : 1}
      />

      {/* Inner label or person icon */}
      {isBrowser && !label ? (
        <PersonIcon />
      ) : (
        <text
          x={0}
          y={1}
          textAnchor="middle"
          dominantBaseline="central"
          className={
            isSelf
              ? "topo-label-self"
              : isBrowser
                ? "topo-label-browser"
                : "topo-label-infra"
          }
        >
          {label}
        </text>
      )}

      {/* Peer ID / name below circle */}
      {!isSelf && (
        <text x={0} y={r + 11} textAnchor="middle" className="topo-peer-id">
          {node.label}
        </text>
      )}

      {/* Browser count badge */}
      {!isSelf &&
        !isBrowser &&
        node.browserCount != null &&
        node.browserCount > 0 && (
          <g transform={`translate(${-(r - 1)},${r - 1})`}>
            <circle r={6} fill="#059669" stroke="#fff" strokeWidth={1} />
            <text
              x={0}
              y={0.5}
              textAnchor="middle"
              dominantBaseline="central"
              className="topo-badge-text"
            >
              {node.browserCount}
            </text>
          </g>
        )}

      {/* Guarantee label below */}
      {showGuarantee && (
        <text
          x={0}
          y={r + 20}
          textAnchor="middle"
          className={
            guaranteeActive
              ? "topo-guarantee-label"
              : "topo-guarantee-label expired"
          }
        >
          {guaranteeActive
            ? `pinned ${formatRelativeTime(guaranteeUntil)}`
            : "expired"}
        </text>
      )}
    </g>
  );
}

// ── Edge rendering ───────────────────────────────

function EdgeLine({
  x1,
  y1,
  x2,
  y2,
  connected,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  connected: boolean;
}) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
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

  const isPinner = node.kind === "pinner" || node.kind === "relay+pinner";
  const now = Date.now();
  const gActive =
    isPinner &&
    node.ackedCurrentCid &&
    guaranteeUntil != null &&
    guaranteeUntil > now;
  const gExpired =
    isPinner &&
    node.ackedCurrentCid &&
    guaranteeUntil != null &&
    guaranteeUntil <= now;

  return (
    <div className="topo-tooltip" style={{ left, top }}>
      <div className="topo-tooltip-kind">
        {node.kind === "self"
          ? "You (this browser)"
          : node.kind === "browser"
            ? "Browser peer"
            : node.kind}
      </div>
      {node.kind !== "self" && (
        <div className="topo-tooltip-id">{node.label}</div>
      )}
      {node.kind !== "self" && node.kind !== "browser" && (
        <div className="topo-tooltip-status">
          {node.connected ? "Connected" : "Disconnected"}
        </div>
      )}
      {node.browserCount != null && node.browserCount > 0 && (
        <div className="topo-tooltip-detail">
          {node.browserCount} browser
          {node.browserCount > 1 ? "s" : ""} connected
        </div>
      )}
      {node.ackedCurrentCid && (
        <div className="topo-tooltip-ack">Acked current snapshot</div>
      )}
      {gActive && (
        <div className={"topo-tooltip-guarantee active"}>
          Pinned for {formatRelativeTime(guaranteeUntil!)}
        </div>
      )}
      {gExpired && (
        <div className={"topo-tooltip-guarantee expired"}>
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
    on(event: string, cb: () => void): void;
    off(event: string, cb: () => void): void;
    awareness: {
      on(event: string, cb: () => void): void;
      off(event: string, cb: () => void): void;
    };
  };
  pulseKey: number;
}) {
  const [graph, setGraph] = useState<TopologyGraph>(() => doc.topologyGraph());
  const [guaranteeUntil, setGuaranteeUntil] = useState<number | null>(
    () => doc.diagnostics().guaranteeUntil,
  );
  const prevFpRef = useRef("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refresh graph data, deduping by fingerprint
  const refreshGraph = useCallback(() => {
    let g: TopologyGraph;
    let gu: number | null;
    try {
      g = doc.topologyGraph();
      gu = doc.diagnostics().guaranteeUntil;
    } catch {
      return; // doc destroyed
    }
    const fp = graphFp(g);

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
  }, [doc]);

  // Subscribe to all events that can change
  // the topology graph
  useEffect(() => {
    refreshGraph();

    doc.on("node-change", refreshGraph);
    doc.on("snapshot", refreshGraph);
    doc.on("ack", refreshGraph);
    doc.awareness.on("change", refreshGraph);

    return () => {
      doc.off("node-change", refreshGraph);
      doc.off("snapshot", refreshGraph);
      doc.off("ack", refreshGraph);
      doc.awareness.off("change", refreshGraph);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [doc, refreshGraph]);

  const posMap = useForceLayout(graph);

  // Keep a ref to posMap for particle lookups
  // (avoids stale closure when topology changes)
  const posMapRef = useRef(posMap);
  posMapRef.current = posMap;

  // Particle animation
  const particleRef = useRef<SVGGElement | null>(null);
  useParticles(particleRef, pulseKey, graph.edges, posMapRef);

  // Tooltip state
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<{
    node: TopologyNode;
    mx: number;
    my: number;
  } | null>(null);

  const onHover = useCallback(
    (n: TopologyNode | null, e?: React.MouseEvent) => {
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
  const sorted = graph.nodes.slice().sort((a, b) => {
    const order = (k: TopologyNode["kind"]) => {
      switch (k) {
        case "browser":
          return 0;
        case "relay":
        case "pinner":
        case "relay+pinner":
          return 1;
        case "self":
          return 2;
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
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
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
          svgRect={svgRef.current.getBoundingClientRect()}
          mouseX={hovered.mx}
          mouseY={hovered.my}
          guaranteeUntil={guaranteeUntil}
        />
      )}
    </div>
  );
}
