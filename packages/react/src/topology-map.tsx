/**
 * TopologyMap — network topology visualization.
 *
 * Shows who else is connected: you, other editors,
 * and server infrastructure (relays + pinners).
 * Uses d3-force layout with particle animations
 * for data flow.
 *
 * Extracted from apps/example with leaked internals
 * removed per product guidance (no peer IDs on infra,
 * no guarantee halos/labels, simplified tooltips).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from "d3-force";
import type {
  ForceLink,
  Simulation,
  SimulationLinkDatum,
  SimulationNodeDatum,
} from "d3-force";
import type {
  TopologyNode,
  TopologyEdge,
  TopologyGraph,
  Feed,
  SnapshotEvent,
  GossipActivity,
  LoadingState,
  VersionInfo,
} from "@pokapali/core";

// ── Labels ──────────────────────────────────────

export interface TopologyMapLabels {
  you: string;
  anotherEditor: string;
  relay: string;
  pinner: string;
  connected: string;
  reconnecting: string;
  hasLatestChanges: string;
  networkLabel: string;
}

export const defaultTopologyMapLabels: TopologyMapLabels = {
  you: "You",
  anotherEditor: "Another editor",
  relay: "Relay",
  pinner: "Pinner",
  connected: "connected",
  reconnecting: "reconnecting",
  hasLatestChanges: "has your latest changes",
  networkLabel: "Network topology",
};

// ── Doc interface ───────────────────────────────

export interface TopologyMapDoc {
  topologyGraph(): TopologyGraph;
  capability: { canPushSnapshots: boolean };
  snapshotEvents: Feed<SnapshotEvent | null>;
  tip: Feed<VersionInfo | null>;
  loading: Feed<LoadingState>;
  gossipActivity: Feed<GossipActivity>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
  awareness: {
    on(event: string, cb: () => void): void;
    off(event: string, cb: () => void): void;
    getStates(): Map<number, Record<string, unknown>>;
    clientID: number;
  };
}

// ── Props ───────────────────────────────────────

export interface TopologyMapProps {
  doc: TopologyMapDoc;
  labels?: Partial<TopologyMapLabels>;
}

// ── Constants ───────────────────────────────────

const W = 400;
const H = 300;
const CX = W / 2;
const CY = H / 2;
const NODE_R = 15;

const C = {
  self: "#10b981",
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
  dual: "#8b5cf6",
  particle: "#fbbf24",
} as const;

// ── Fingerprint for structural changes ──────────

function graphFp(graph: TopologyGraph): string {
  return (
    graph.nodes
      .map(
        (n) =>
          `${n.id}:${n.kind}:${n.connected}` +
          `:${n.ackedCurrentCid ?? ""}` +
          `:${n.label}`,
      )
      .sort()
      .join("|") +
    "||" +
    graph.edges
      .map((e) => `${e.source}-${e.target}:${e.connected}`)
      .sort()
      .join("|")
  );
}

// ── Node removal grace period ───────────────────

const GRACE_MS = 12_000;

interface DepartingNode {
  node: TopologyNode;
  edges: TopologyEdge[];
  departedAt: number;
}

function buildStableGraph(
  live: TopologyGraph,
  departing: Map<string, DepartingNode>,
): TopologyGraph {
  const now = Date.now();
  const liveIds = new Set(live.nodes.map((n) => n.id));

  for (const [id, dn] of departing) {
    if (liveIds.has(id)) {
      departing.delete(id);
    } else if (now - dn.departedAt > GRACE_MS) {
      departing.delete(id);
    }
  }

  const extraNodes: TopologyNode[] = [];
  const extraEdges: TopologyEdge[] = [];
  for (const dn of departing.values()) {
    extraNodes.push({
      ...dn.node,
      connected: false,
    });
    for (const e of dn.edges) {
      const other = e.source === dn.node.id ? e.target : e.source;
      if (liveIds.has(other) || departing.has(other)) {
        extraEdges.push({ ...e, connected: false });
      }
    }
  }

  return {
    nodes: [...live.nodes, ...extraNodes],
    edges: [...live.edges, ...extraEdges],
  };
}

function departingOpacity(departedAt: number): number {
  const elapsed = Date.now() - departedAt;
  if (elapsed >= GRACE_MS) return 0;
  const fadeStart = 4_000;
  if (elapsed < fadeStart) return 1;
  return 1 - (elapsed - fadeStart) / (GRACE_MS - fadeStart);
}

// ── Force layout hook ───────────────────────────

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

function linkDistanceFn(l: SimulationLinkDatum<SimNode>): number {
  const s = l.source as SimNode;
  const t = l.target as SimNode;
  if (isInfra(s.kind) && isInfra(t.kind)) return 55;
  return 110;
}

function linkStrengthFn(l: SimulationLinkDatum<SimNode>): number {
  const s = l.source as SimNode;
  const t = l.target as SimNode;
  if (isInfra(s.kind) && isInfra(t.kind)) return 0.9;
  return 0.15;
}

function chargeFn(d: SimNode): number {
  return isInfra(d.kind) ? -120 : -150;
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

  useEffect(() => {
    const tick = () => {
      const m = new Map<string, { x: number; y: number }>();
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
        forceLink<SimNode, SimulationLinkDatum<SimNode>>([])
          .id((d: SimNode) => d.id)
          .distance(linkDistanceFn)
          .strength(linkStrengthFn),
      )
      .force("charge", forceManyBody<SimNode>().strength(chargeFn))
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius(() => NODE_R + 12)
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

  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;

    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nextIds = new Set(graph.nodes.map((n) => n.id));

    const nodes: SimNode[] = graph.nodes.map((n) => {
      const existing = prev.get(n.id);
      if (existing) {
        existing.kind = n.kind;
        return existing;
      }
      return {
        id: n.id,
        kind: n.kind,
        x: CX + (Math.random() - 0.5) * 80,
        y: CY + (Math.random() - 0.5) * 60,
        vx: 0,
        vy: 0,
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

    sim.nodes(nodes);
    const linkForce = sim.force("link") as
      | ForceLink<SimNode, SimulationLinkDatum<SimNode>>
      | undefined;
    linkForce?.links(links);

    const structural =
      nextIds.size !== prev.size || [...nextIds].some((id) => !prev.has(id));
    sim.alpha(structural ? 0.3 : 0.08).restart();
  }, [graph]);

  return posMap;
}

// ── Particle animation ──────────────────────────

interface ParticleSpec {
  srcId: string;
  tgtId: string;
  color: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

interface LiveParticle {
  el: SVGCircleElement;
  srcId: string;
  tgtId: string;
  born: number;
  dur: number;
}

interface ParticlePool {
  particles: LiveParticle[];
  raf: number;
  running: boolean;
}

function createParticlePool(): ParticlePool {
  return { particles: [], raf: 0, running: false };
}

function startLoop(
  pool: ParticlePool,
  posMapRef: React.RefObject<Map<string, { x: number; y: number }>>,
) {
  if (pool.running) return;
  pool.running = true;

  const tick = (t: number) => {
    const pm = posMapRef.current;
    let alive = 0;
    for (let i = pool.particles.length - 1; i >= 0; i--) {
      const p = pool.particles[i]!;
      if (t < p.born) {
        alive++;
        continue;
      }
      const frac = (t - p.born) / p.dur;
      if (frac >= 1) {
        p.el.remove();
        pool.particles.splice(i, 1);
        continue;
      }
      const s = pm.get(p.srcId);
      const d = pm.get(p.tgtId);
      if (!s || !d) {
        p.el.remove();
        pool.particles.splice(i, 1);
        continue;
      }
      alive++;
      const ease = 1 - (1 - frac) ** 2;
      p.el.setAttribute("cx", String(s.x + (d.x - s.x) * ease));
      p.el.setAttribute("cy", String(s.y + (d.y - s.y) * ease));
      p.el.setAttribute(
        "opacity",
        String(frac < 0.7 ? 0.85 : (1 - frac) / 0.3),
      );
    }
    if (alive > 0) {
      pool.raf = requestAnimationFrame(tick);
    } else {
      pool.running = false;
    }
  };

  pool.raf = requestAnimationFrame(tick);
}

function destroyPool(pool: ParticlePool) {
  cancelAnimationFrame(pool.raf);
  pool.running = false;
  for (const p of pool.particles) p.el.remove();
  pool.particles.length = 0;
}

function spawnParticles(
  g: SVGGElement,
  specs: ParticleSpec[],
  posMapRef: React.RefObject<Map<string, { x: number; y: number }>>,
  pool: ParticlePool,
) {
  const now = performance.now();

  for (const spec of specs) {
    const pm = posMapRef.current;
    if (!pm.has(spec.srcId) || !pm.has(spec.tgtId)) {
      continue;
    }
    const count = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("r", "2.5");
      el.setAttribute("fill", spec.color);
      el.setAttribute("opacity", "0");
      g.appendChild(el);
      pool.particles.push({
        el,
        srcId: spec.srcId,
        tgtId: spec.tgtId,
        born: now + i * 150 + Math.random() * 100,
        dur: 700 + Math.random() * 500,
      });
    }
  }

  startLoop(pool, posMapRef);
}

// ── Person silhouette for anonymous browsers ────

function PersonIcon() {
  return (
    <g opacity={0.7}>
      <circle cx={0} cy={-2} r={4} fill="#fff" />
      <path d="M-6,7 Q-6,2 0,2 Q6,2 6,7" fill="#fff" />
    </g>
  );
}

// ── Browser label helpers ───────────────────────

function browserAbbrev(label: string): string {
  const name = label.replace(/^…/, "").trim();
  if (!name || name === "Anonymous") return "";
  return name.slice(0, 2).toUpperCase();
}

// ── Diamond helpers ─────────────────────────────

function diamondPoints(r: number): string {
  return `0,${-r} ${r},0 0,${r} ${-r},0`;
}

// ── Role pill tags ──────────────────────────────

function RelayIcon() {
  return (
    <g>
      <path
        d={"M-3,-1.5 L1,-1.5 " + "M-1,-3.5 L-3,-1.5 L-1,0.5"}
        fill="none"
        stroke="#fff"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={"M3,1.5 L-1,1.5 " + "M1,-0.5 L3,1.5 L1,3.5"}
        fill="none"
        stroke="#fff"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

function PinnerIcon() {
  return (
    <g>
      <ellipse
        cx={0}
        cy={-2.5}
        rx={3.5}
        ry={1.5}
        fill="none"
        stroke="#fff"
        strokeWidth={1}
      />
      <path d="M-3.5,-2.5 L-3.5,2.5" stroke="#fff" strokeWidth={1} />
      <path d="M3.5,-2.5 L3.5,2.5" stroke="#fff" strokeWidth={1} />
      <ellipse
        cx={0}
        cy={2.5}
        rx={3.5}
        ry={1.5}
        fill="none"
        stroke="#fff"
        strokeWidth={1}
      />
    </g>
  );
}

function RolePill({
  role,
  dx,
  dy,
}: {
  role: "relay" | "pinner";
  dx: number;
  dy: number;
}) {
  const bg = role === "relay" ? C.relay : C.pinner;
  return (
    <g transform={`translate(${dx},${dy})`}>
      <rect
        x={-9}
        y={-7}
        width={18}
        height={14}
        rx={7}
        fill={bg}
        stroke="#fff"
        strokeWidth={0.8}
      />
      {role === "relay" ? <RelayIcon /> : <PinnerIcon />}
    </g>
  );
}

// ── Node rendering ──────────────────────────────

function NodeShape({
  node,
  x,
  y,
  onHover,
  awarenessColor,
  groupOpacity,
  labels,
}: {
  node: TopologyNode;
  x: number;
  y: number;
  onHover: (n: TopologyNode | null, e?: React.MouseEvent) => void;
  awarenessColor?: string;
  groupOpacity?: number;
  labels: TopologyMapLabels;
}) {
  const isSelf = node.kind === "self";
  const isBrowser = node.kind === "browser" || isSelf;
  const isDiamond = isInfra(node.kind);
  const r = NODE_R;
  const off = !node.connected && !isSelf;

  const handleEnter = useCallback(
    (e: React.MouseEvent) => onHover(node, e),
    [node, onHover],
  );
  const handleLeave = useCallback(() => onHover(null), [onHover]);

  const isPinner = node.kind === "pinner" || node.kind === "relay+pinner";
  const isRelay = node.kind === "relay" || node.kind === "relay+pinner";

  // Fill and stroke
  let fill: string;
  let stroke: string;
  let strokeW: number;
  if (off) {
    fill = C.disconnected;
    stroke = C.disconnectedStroke;
    strokeW = 1.5;
  } else if (isDiamond) {
    fill =
      node.kind === "relay"
        ? C.relay
        : node.kind === "pinner"
          ? C.pinner
          : C.dual;
    stroke = "#fff";
    strokeW = 1.5;
  } else if (isBrowser) {
    fill = awarenessColor ?? C.browser;
    stroke = "#fff";
    strokeW = 2;
  } else {
    fill = C.nodeFill;
    stroke = C.nodeStroke;
    strokeW = 2;
  }

  // Inner label (browsers only)
  let label = "";
  if (isSelf) {
    label = labels.you;
  } else if (isBrowser) {
    label = browserAbbrev(node.label);
  }

  // Build accessible title (simplified — no
  // peer IDs, no guarantee info)
  const tip: string[] = [];
  if (isSelf) {
    tip.push(labels.you);
  } else if (isBrowser) {
    tip.push(node.label || labels.anotherEditor);
  } else {
    const roles: string[] = [];
    if (isRelay) roles.push(labels.relay);
    if (isPinner) roles.push(labels.pinner);
    tip.push(roles.join(" + "));
    if (off) {
      tip.push(`\u2014 ${labels.reconnecting}`);
    } else if (isPinner && node.ackedCurrentCid) {
      tip.push(`\u2014 ${labels.hasLatestChanges}`);
    } else {
      tip.push(`\u2014 ${labels.connected}`);
    }
  }

  // Role pills at bottom-left
  const pills: Array<"relay" | "pinner"> = [];
  if (isRelay) pills.push("relay");
  if (isPinner) pills.push("pinner");

  return (
    <g
      transform={`translate(${x},${y})`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ cursor: "default" }}
      opacity={groupOpacity ?? 1}
    >
      <title>{tip.join(" ")}</title>

      {/* Main shape */}
      {isDiamond ? (
        <polygon
          points={diamondPoints(r)}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeDasharray={off ? "3 2" : "none"}
          opacity={off ? 0.5 : 1}
          strokeLinejoin="round"
        />
      ) : (
        <circle
          cx={0}
          cy={0}
          r={r}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeDasharray={off ? "3 2" : "none"}
          opacity={off ? 0.5 : 1}
        />
      )}

      {/* Inner label or person icon */}
      {isBrowser && !label ? (
        <PersonIcon />
      ) : label ? (
        <text
          x={0}
          y={1}
          textAnchor="middle"
          dominantBaseline="central"
          className="poka-topology__label--self"
        >
          {label}
        </text>
      ) : null}

      {/* Display name below browser peers */}
      {isBrowser && !isSelf && node.label && (
        <text
          x={0}
          y={r + 11}
          textAnchor="middle"
          className="poka-topology__peer-name"
        >
          {node.label}
        </text>
      )}

      {/* Role pill tags at bottom-left */}
      {!off &&
        pills.map((role, i) => (
          <RolePill key={role} role={role} dx={-(r - 1)} dy={r - 1 + i * 16} />
        ))}
    </g>
  );
}

// ── Edge rendering ──────────────────────────────

function EdgeLine({
  x1,
  y1,
  x2,
  y2,
  connected,
  thick,
  opacity,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  connected: boolean;
  thick: boolean;
  opacity?: number;
}) {
  const baseOpacity = connected ? (thick ? 0.7 : 0.5) : 0.25;
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={connected ? C.edge : C.edgeDash}
      strokeWidth={connected ? (thick ? 2.5 : 1.2) : 0.8}
      strokeDasharray={connected ? "none" : "4 3"}
      strokeOpacity={opacity != null ? baseOpacity * opacity : baseOpacity}
    />
  );
}

// ── Tooltip ─────────────────────────────────────

function Tooltip({
  node,
  svgRect,
  mouseX,
  mouseY,
  labels,
}: {
  node: TopologyNode;
  svgRect: DOMRect;
  mouseX: number;
  mouseY: number;
  labels: TopologyMapLabels;
}) {
  const left = mouseX - svgRect.left + 12;
  const top = mouseY - svgRect.top - 10;

  const isSelf = node.kind === "self";
  const isBrowser = node.kind === "browser" || isSelf;
  const isPinner = node.kind === "pinner" || node.kind === "relay+pinner";
  const isRelay = node.kind === "relay" || node.kind === "relay+pinner";
  const off = !node.connected && !isSelf;

  // Title line
  let title: string;
  if (isSelf) {
    title = labels.you;
  } else if (isBrowser) {
    title = node.label || labels.anotherEditor;
  } else {
    const roles: string[] = [];
    if (isRelay) roles.push(labels.relay);
    if (isPinner) roles.push(labels.pinner);
    title = roles.join(" + ");
  }

  // Status line for infra nodes
  let status: string | null = null;
  if (!isBrowser) {
    if (off) {
      status = labels.reconnecting;
    } else if (isPinner && node.ackedCurrentCid) {
      status = labels.hasLatestChanges;
    } else {
      status = labels.connected;
    }
  }

  return (
    <div className="poka-topology__tooltip" style={{ left, top }}>
      <div className="poka-topology__tooltip-title">{title}</div>
      {status && <div className="poka-topology__tooltip-status">{status}</div>}
      {node.browserCount != null && node.browserCount > 0 && (
        <div className={"poka-topology__tooltip-detail"}>
          {node.browserCount} browser
          {node.browserCount > 1 ? "s" : ""} connected
        </div>
      )}
    </div>
  );
}

// ── Resolve labels ──────────────────────────────

function resolveLabels(
  partial?: Partial<TopologyMapLabels>,
): TopologyMapLabels {
  if (!partial) return defaultTopologyMapLabels;
  return {
    ...defaultTopologyMapLabels,
    ...partial,
  };
}

// ── Main component ──────────────────────────────

export function TopologyMap({ doc, labels: labelsProp }: TopologyMapProps) {
  const labels = resolveLabels(labelsProp);

  const [graph, setGraph] = useState<TopologyGraph>(() => doc.topologyGraph());
  const prevFpRef = useRef("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const departingRef = useRef<Map<string, DepartingNode>>(new Map());
  const prevLiveIdsRef = useRef<Set<string>>(new Set());
  const prevGraphRef = useRef<TopologyGraph>(graph);
  prevGraphRef.current = graph;

  const refreshGraph = useCallback(() => {
    let live: TopologyGraph;
    try {
      live = doc.topologyGraph();
    } catch {
      return;
    }

    const liveIds = new Set(live.nodes.map((n) => n.id));
    const prev = prevGraphRef.current;

    for (const id of prevLiveIdsRef.current) {
      if (!liveIds.has(id) && !departingRef.current.has(id)) {
        const node = prev.nodes.find((n) => n.id === id);
        if (node) {
          departingRef.current.set(id, {
            node,
            edges: prev.edges.filter((e) => e.source === id || e.target === id),
            departedAt: Date.now(),
          });
        }
      }
    }
    prevLiveIdsRef.current = liveIds;

    const stable = buildStableGraph(live, departingRef.current);

    const fp = graphFp(stable);
    if (fp !== prevFpRef.current) {
      prevFpRef.current = fp;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      setGraph(stable);
    } else {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        setGraph(stable);
      }, 8_000);
    }
  }, [doc]);

  useEffect(() => {
    refreshGraph();

    const unsubs = [
      doc.snapshotEvents.subscribe(refreshGraph),
      doc.tip.subscribe(refreshGraph),
    ];
    doc.on("node-change", refreshGraph);
    doc.awareness.on("change", refreshGraph);

    const fadeTimer = setInterval(() => {
      if (departingRef.current.size > 0) {
        refreshGraph();
      }
    }, 2_000);

    return () => {
      unsubs.forEach((u) => u());
      doc.off("node-change", refreshGraph);
      doc.awareness.off("change", refreshGraph);
      clearInterval(fadeTimer);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [doc, refreshGraph]);

  const posMap = useForceLayout(graph);

  // Awareness color map
  const awarenessColors = (() => {
    const m = new Map<string, string>();
    const states = doc.awareness.getStates();
    const myId = doc.awareness.clientID;
    const myState = states.get(myId) as
      | { user?: { color?: string } }
      | undefined;
    if (myState?.user?.color) {
      m.set("_self", myState.user.color);
    }
    for (const [clientId, state] of states) {
      if (clientId === myId) continue;
      const s = state as {
        user?: { color?: string };
      };
      if (s?.user?.color) {
        m.set(`awareness:${clientId}`, s.user.color);
      }
    }
    return m;
  })();

  const posMapRef = useRef(posMap);
  posMapRef.current = posMap;

  // Particle animation
  const particleRef = useRef<SVGGElement | null>(null);
  const poolRef = useRef(createParticlePool());
  const graphRef = useRef(graph);
  graphRef.current = graph;

  useEffect(() => {
    const g = particleRef.current;
    if (!g) return;
    const pool = poolRef.current;

    const selfInfraEdges = () =>
      graphRef.current.edges
        .filter(
          (e) => e.connected && (e.source === "_self" || e.target === "_self"),
        )
        .map((e) => (e.source === "_self" ? e.target : e.source))
        .filter((id) => {
          const n = graphRef.current.nodes.find((nd) => nd.id === id);
          return n && isInfra(n.kind);
        });

    const onSnapshot = () => {
      const infra = selfInfraEdges();
      if (infra.length === 0) return;
      const isWriter = doc.capability.canPushSnapshots;
      const color = isWriter ? C.particle : "#22c55e";
      const specs: ParticleSpec[] = infra.map((id) =>
        isWriter
          ? { srcId: "_self", tgtId: id, color }
          : {
              srcId: id,
              tgtId: "_self",
              color,
            },
      );
      spawnParticles(g, specs, posMapRef, pool);
    };

    const onAck = (...args: unknown[]) => {
      const peerId = args[0];
      if (typeof peerId !== "string") return;
      const node = graphRef.current.nodes.find((n) => n.id === peerId);
      if (!node) return;
      spawnParticles(
        g,
        [
          {
            srcId: peerId,
            tgtId: "_self",
            color: "#22c55e",
          },
        ],
        posMapRef,
        pool,
      );
    };

    const onLoading = () => {
      const state = doc.loading.getSnapshot();
      if (!state) return;
      const active =
        state.status === "resolving" || state.status === "fetching";
      if (!active) return;
      const infra = selfInfraEdges();
      if (infra.length === 0) return;
      const idx = Math.floor(Math.random() * infra.length);
      spawnParticles(
        g,
        [
          {
            srcId: infra[idx]!,
            tgtId: "_self",
            color: C.relay,
          },
        ],
        posMapRef,
        pool,
      );
    };

    const onGossip = () => {
      const activity = doc.gossipActivity.getSnapshot();
      if (activity !== "receiving") return;
      const infra = selfInfraEdges();
      if (infra.length === 0) return;
      const idx = Math.floor(Math.random() * infra.length);
      spawnParticles(
        g,
        [
          {
            srcId: infra[idx]!,
            tgtId: "_self",
            color: C.edge,
          },
        ],
        posMapRef,
        pool,
      );
    };

    const onGuaranteeQuery = () => {
      const pinners = graphRef.current.nodes
        .filter(
          (n) =>
            n.connected && (n.kind === "pinner" || n.kind === "relay+pinner"),
        )
        .map((n) => n.id);
      if (pinners.length === 0) return;
      spawnParticles(
        g,
        pinners.map((id) => ({
          srcId: "_self",
          tgtId: id,
          color: C.pinner,
        })),
        posMapRef,
        pool,
      );
    };

    const unsubs = [
      doc.snapshotEvents.subscribe(onSnapshot),
      doc.loading.subscribe(onLoading),
      doc.gossipActivity.subscribe(onGossip),
    ];
    doc.on("ack", onAck);
    doc.on("guarantee-query", onGuaranteeQuery);

    return () => {
      unsubs.forEach((u) => u());
      doc.off("ack", onAck);
      doc.off("guarantee-query", onGuaranteeQuery);
      destroyPool(pool);
    };
  }, [doc, posMapRef]);

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

  // Render order: browsers/self behind infra
  const sorted = graph.nodes.slice().sort((a, b) => {
    const order = (k: TopologyNode["kind"]) => {
      switch (k) {
        case "browser":
        case "self":
          return 0;
        case "relay":
        case "pinner":
        case "relay+pinner":
          return 1;
      }
    };
    return order(a.kind) - order(b.kind);
  });

  const nodeKindMap = new Map(graph.nodes.map((n) => [n.id, n.kind]));

  return (
    <div className="poka-topology">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="poka-topology__svg"
        aria-label={labels.networkLabel}
      >
        {graph.edges.map((e) => {
          const s = posMap.get(e.source);
          const t = posMap.get(e.target);
          if (!s || !t) return null;
          const sk = nodeKindMap.get(e.source);
          const tk = nodeKindMap.get(e.target);
          const thick = sk != null && tk != null && isInfra(sk) && isInfra(tk);
          const ds = departingRef.current.get(e.source);
          const dt = departingRef.current.get(e.target);
          const edgeOpacity = ds
            ? departingOpacity(ds.departedAt)
            : dt
              ? departingOpacity(dt.departedAt)
              : undefined;
          return (
            <EdgeLine
              key={`${e.source}-${e.target}`}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              connected={e.connected}
              thick={thick}
              opacity={edgeOpacity}
            />
          );
        })}

        <g ref={particleRef} />

        {sorted.map((n) => {
          const p = posMap.get(n.id);
          if (!p) return null;
          const dn = departingRef.current.get(n.id);
          const opacity = dn ? departingOpacity(dn.departedAt) : undefined;
          return (
            <NodeShape
              key={n.id}
              node={n}
              x={p.x}
              y={p.y}
              onHover={onHover}
              awarenessColor={awarenessColors.get(n.id)}
              groupOpacity={opacity}
              labels={labels}
            />
          );
        })}
      </svg>

      {hovered && svgRef.current && (
        <Tooltip
          node={hovered.node}
          svgRect={svgRef.current.getBoundingClientRect()}
          mouseX={hovered.mx}
          mouseY={hovered.my}
          labels={labels}
        />
      )}
    </div>
  );
}
