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
  Diagnostics,
  Feed,
  SnapshotEvent,
  GossipActivity,
  LoadingState,
  VersionInfo,
} from "@pokapali/core";
import { formatRelativeTime } from "./ConnectionStatus";

// ── Constants ────────────────────────────────────

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
          `${n.id}:${n.kind}:${n.connected}` +
          `:${n.ackedCurrentCid ?? ""}` +
          `:${n.label}`,
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

// ── Node removal grace period ────────────────────
//
// When a node disappears from the live graph, keep
// it visible for GRACE_MS with fading opacity to
// prevent flicker from transient disconnects.

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

  // Mark newly departed nodes
  for (const [id, dn] of departing) {
    if (liveIds.has(id)) {
      // Node came back — remove from departing
      departing.delete(id);
    } else if (now - dn.departedAt > GRACE_MS) {
      // Grace period expired
      departing.delete(id);
    }
  }

  // Collect departing nodes still within grace
  const extraNodes: TopologyNode[] = [];
  const extraEdges: TopologyEdge[] = [];
  for (const dn of departing.values()) {
    // Mark as disconnected so it renders faded
    extraNodes.push({
      ...dn.node,
      connected: false,
    });
    for (const e of dn.edges) {
      // Only include edge if the other endpoint
      // is still in the live or departing set
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

/** Opacity for a departing node (1 → 0 over grace) */
function departingOpacity(departedAt: number): number {
  const elapsed = Date.now() - departedAt;
  if (elapsed >= GRACE_MS) return 0;
  // Hold full opacity for first 4s, then fade
  const fadeStart = 4_000;
  if (elapsed < fadeStart) return 1;
  return 1 - (elapsed - fadeStart) / (GRACE_MS - fadeStart);
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

function linkDistanceFn(l: SimulationLinkDatum<SimNode>): number {
  const s = l.source as SimNode;
  const t = l.target as SimNode;
  if (isInfra(s.kind) && isInfra(t.kind)) {
    return 55; // slightly more spacing for thick links
  }
  // Browser/self → relay: long leash so
  // browsers orbit outside the infra cluster
  return 110;
}

function linkStrengthFn(l: SimulationLinkDatum<SimNode>): number {
  const s = l.source as SimNode;
  const t = l.target as SimNode;
  if (isInfra(s.kind) && isInfra(t.kind)) {
    return 0.9;
  }
  // Browser/self → relay: weak pull so relays
  // aren't dragged outward
  return 0.15;
}

function chargeFn(d: SimNode): number {
  if (isInfra(d.kind)) return -120;
  // Browsers (including self) repel each other
  // to spread around the relay cluster
  return -150;
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
        existing.kind = n.kind;
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
    const linkForce = sim.force("link") as
      | ForceLink<SimNode, SimulationLinkDatum<SimNode>>
      | undefined;
    linkForce?.links(links);

    // Structural change (nodes added/removed):
    // moderate reheat. Data-only change: gentle.
    const structural =
      nextIds.size !== prev.size || [...nextIds].some((id) => !prev.has(id));
    sim.alpha(structural ? 0.3 : 0.08).restart();
  }, [graph]);

  return posMap;
}

// ── Particle animation (event-driven, directional)
//
// Particles represent actual data flow:
// - "snapshot" event (writer): outbound self → infra
// - "snapshot" event (reader): inbound infra → self
// - "ack" event: inbound from specific pinner → self

interface ParticleSpec {
  srcId: string;
  tgtId: string;
  color: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// ── Particle pool ────────────────────────────────
//
// Single animation loop manages all particles.
// Previous design had each spawnParticles() call
// create its own rAF loop + cancel the previous
// one, orphaning in-flight particles' DOM elements
// (the "stalled particles" bug).

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

  // Kick the loop if not already running
  startLoop(pool, posMapRef);
}

// ── Person silhouette for anonymous browsers ─────

function PersonIcon() {
  // Simple head + shoulders silhouette
  return (
    <g opacity={0.7}>
      <circle cx={0} cy={-2} r={4} fill="#fff" />
      <path d="M-6,7 Q-6,2 0,2 Q6,2 6,7" fill="#fff" />
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

// ── Diamond helpers ──────────────────────────────

function diamondPoints(r: number): string {
  return `0,${-r} ${r},0 0,${r} ${-r},0`;
}

// ── Role pill tags ──────────────────────────────

function RelayIcon() {
  // Two small opposing arrows (⇋-style)
  return (
    <g>
      <path
        d="M-3,-1.5 L1,-1.5 M-1,-3.5 L-3,-1.5 L-1,0.5"
        fill="none"
        stroke="#fff"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3,1.5 L-1,1.5 M1,-0.5 L3,1.5 L1,3.5"
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
  // Tiny database cylinder (3 stacked ellipses)
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

// ── Node rendering ───────────────────────────────

function NodeShape({
  node,
  x,
  y,
  guaranteeUntil,
  onHover,
  awarenessColor,
  groupOpacity,
}: {
  node: TopologyNode;
  x: number;
  y: number;
  guaranteeUntil: number | null;
  onHover: (n: TopologyNode | null, e?: React.MouseEvent) => void;
  awarenessColor?: string;
  groupOpacity?: number;
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

  // Determine roles
  const isPinner = node.kind === "pinner" || node.kind === "relay+pinner";
  const isRelay = node.kind === "relay" || node.kind === "relay+pinner";

  // Guarantee state
  const now = Date.now();
  const showGuarantee =
    isPinner && node.ackedCurrentCid && guaranteeUntil != null;
  const guaranteeActive = showGuarantee ? guaranteeUntil > now : false;

  // Fill and stroke
  let fill: string;
  let stroke: string;
  let strokeW: number;
  if (off) {
    fill = C.disconnected;
    stroke = C.disconnectedStroke;
    strokeW = 1.5;
  } else if (isDiamond) {
    // Infra diamonds: solid role color fill
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

  // Inner label (infra nodes don't show text
  // labels — role pills handle identification)
  let label = "";
  if (isSelf) {
    label = "You";
  } else if (isBrowser) {
    label = browserAbbrev(node.label);
  }

  // Peer ID: short abbreviation, no dots prefix
  const shortId = !isSelf && !isBrowser ? node.id.slice(-8) : node.label;

  // Build tooltip
  const tip = [node.label];
  if (!isSelf && !isBrowser) {
    const roles: string[] = [];
    if (isRelay) roles.push("relay");
    if (isPinner) roles.push("pinner");
    tip.push(`(${roles.join(", ")})`);
  }
  if (node.ackedCurrentCid) tip.push("— acked");
  if (showGuarantee) {
    tip.push(
      guaranteeActive
        ? `— retained ` + `${formatRelativeTime(guaranteeUntil)}+`
        : "— guarantee expired",
    );
  }
  if (off) tip.push("— disconnected");

  // Role pills: positioned at bottom-left
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

      {/* Pulsing guarantee halo */}
      {showGuarantee &&
        (isDiamond ? (
          <polygon
            points={diamondPoints(r + 6)}
            fill="none"
            stroke={guaranteeActive ? C.guaranteeActive : C.guaranteeExpired}
            strokeWidth={guaranteeActive ? 2.5 : 1.5}
            strokeDasharray={guaranteeActive ? "none" : "3 2"}
            className={
              guaranteeActive ? "topo-guarantee-pulse" : "topo-guarantee-fade"
            }
          />
        ) : (
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
        ))}

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
          className="topo-label-self"
        >
          {label}
        </text>
      ) : null}

      {/* Peer ID below shape */}
      {!isSelf && (
        <text x={0} y={r + 11} textAnchor="middle" className="topo-peer-id">
          {shortId}
        </text>
      )}

      {/* Role pill tags at bottom-left */}
      {!off &&
        pills.map((role, i) => (
          <RolePill key={role} role={role} dx={-(r - 1)} dy={r - 1 + i * 16} />
        ))}

      {/* Guarantee label below */}
      {showGuarantee && (
        <text
          x={0}
          y={r + 22 + pills.length * 2}
          textAnchor="middle"
          className={
            guaranteeActive
              ? "topo-guarantee-label"
              : "topo-guarantee-label expired"
          }
        >
          {guaranteeActive
            ? `retained ` + `${formatRelativeTime(guaranteeUntil)}+`
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

  const isRelayNode = node.kind === "relay" || node.kind === "relay+pinner";
  const isPinnerNode = node.kind === "pinner" || node.kind === "relay+pinner";

  // Build role tag list
  const roleTags: string[] = [];
  if (isRelayNode) roleTags.push("relay");
  if (isPinnerNode) roleTags.push("pinner");

  return (
    <div className="topo-tooltip" style={{ left, top }}>
      <div className="topo-tooltip-kind">
        {node.kind === "self"
          ? "You (this browser)"
          : node.kind === "browser"
            ? "Browser peer"
            : roleTags.join(" + ")}
      </div>
      {node.kind !== "self" && (
        <div className="topo-tooltip-id">
          {node.id.startsWith("awareness:") ? node.label : node.id}
        </div>
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
        <>
          <div className={"topo-tooltip-guarantee active"}>
            Retained {formatRelativeTime(guaranteeUntil!)}+
          </div>
          <div className="topo-tooltip-detail">
            Rolling minimum — pinners auto-refresh
          </div>
        </>
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
}: {
  doc: {
    topologyGraph(): TopologyGraph;
    diagnostics(): Diagnostics;
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
  };
}) {
  const [graph, setGraph] = useState<TopologyGraph>(() => doc.topologyGraph());
  const [guaranteeUntil, setGuaranteeUntil] = useState<number | null>(
    () => doc.diagnostics().guaranteeUntil,
  );
  const prevFpRef = useRef("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const departingRef = useRef<Map<string, DepartingNode>>(new Map());
  const prevLiveIdsRef = useRef<Set<string>>(new Set());
  const prevGraphRef = useRef<TopologyGraph>(graph);
  prevGraphRef.current = graph;

  // Refresh graph data, deduping by fingerprint
  const refreshGraph = useCallback(() => {
    let live: TopologyGraph;
    let gu: number | null;
    try {
      live = doc.topologyGraph();
      gu = doc.diagnostics().guaranteeUntil;
    } catch {
      return; // doc destroyed
    }
    setGuaranteeUntil(gu);

    const liveIds = new Set(live.nodes.map((n) => n.id));
    const prev = prevGraphRef.current;

    // Detect newly departed nodes
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

    // Build stable graph (live + departing)
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

  // Subscribe to all events that can change
  // the topology graph
  useEffect(() => {
    refreshGraph();

    const unsubs = [
      doc.snapshotEvents.subscribe(refreshGraph),
      doc.tip.subscribe(refreshGraph),
    ];
    doc.on("node-change", refreshGraph);
    doc.awareness.on("change", refreshGraph);

    // Periodic refresh to animate departing node
    // fade-out and clean up expired entries
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

  // Build awareness color map for browser nodes
  // (clientId → color from awareness user state)
  const awarenessColors = (() => {
    const m = new Map<string, string>();
    const states = doc.awareness.getStates();
    const myId = doc.awareness.clientID;
    // Self node color
    const myState = states.get(myId) as
      | { user?: { color?: string } }
      | undefined;
    if (myState?.user?.color) {
      m.set("_self", myState.user.color);
    }
    // Browser peer colors (keyed by awareness:clientId)
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

  // Keep a ref to posMap for particle lookups
  // (avoids stale closure when topology changes)
  const posMapRef = useRef(posMap);
  posMapRef.current = posMap;

  // Particle animation — event-driven, directional
  const particleRef = useRef<SVGGElement | null>(null);
  const poolRef = useRef(createParticlePool());
  const graphRef = useRef(graph);
  graphRef.current = graph;

  useEffect(() => {
    const g = particleRef.current;
    if (!g) return;
    const pool = poolRef.current;

    // Connected infra node IDs for self edges
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

    // Snapshot: writer → outbound to infra,
    //           reader → inbound from infra
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

    // Ack: inbound from specific pinner → self
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

    // Loading: inbound particles during block
    // fetches (resolving/fetching).
    // Blue particles from infra → self.
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

    // Gossip activity: ambient particle when
    // receiving GossipSub messages.
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

    // Guarantee query: outbound self → pinners
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

  // Node kind lookup for edge thickness
  const nodeKindMap = new Map(graph.nodes.map((n) => [n.id, n.kind]));

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
          const sk = nodeKindMap.get(e.source);
          const tk = nodeKindMap.get(e.target);
          const thick = sk != null && tk != null && isInfra(sk) && isInfra(tk);
          // Fade edges connected to departing nodes
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

        {/* Particle layer */}
        <g ref={particleRef} />

        {/* Nodes */}
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
              guaranteeUntil={guaranteeUntil}
              onHover={onHover}
              awarenessColor={awarenessColors.get(n.id)}
              groupOpacity={opacity}
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
