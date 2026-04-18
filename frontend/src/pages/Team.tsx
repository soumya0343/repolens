import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { API_BASE_URL } from "../lib/apiConfig";
import Tooltip from "../components/Tooltip";

const authHdr = () => ({ Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` });
async function apiFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHdr() });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

interface TeamNode { id: string; commit_count: number; betweenness?: number }
interface TeamEdge { source: string; target: string; weight: number }
interface BusFactor {
  overall_bus_factor: number;
  risk_level: string;
  contributors: { name: string; share: number; weighted_commits: number }[];
  recommendations: string[];
}

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "18px 20px",
};

const riskLevelColor = (level: string) => {
  switch (level?.toLowerCase()) {
    case "critical": return "var(--danger)";
    case "high": return "var(--danger)";
    case "medium": return "var(--warning)";
    default: return "var(--accent)";
  }
};

// ── Force-simulation (spring layout) via simple iterative approach ─────────
function useForceLayout(nodes: TeamNode[], edges: TeamEdge[], w: number, h: number) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    if (!nodes.length) return;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.38;
    const pos: Record<string, { x: number; y: number; vx: number; vy: number }> = {};

    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      pos[n.id] = { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle), vx: 0, vy: 0 };
    });

    // simple spring iterations
    for (let iter = 0; iter < 80; iter++) {
      // repulsion
      nodes.forEach(a => nodes.forEach(b => {
        if (a.id === b.id) return;
        const dx = pos[a.id].x - pos[b.id].x;
        const dy = pos[a.id].y - pos[b.id].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = 3000 / (d * d);
        pos[a.id].vx += (dx / d) * f;
        pos[a.id].vy += (dy / d) * f;
      }));
      // attraction via edges
      edges.forEach(e => {
        const a = pos[e.source], b = pos[e.target];
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const natural = 80 + (1 - e.weight) * 60;
        const f = (d - natural) * 0.05;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      });
      // center gravity
      nodes.forEach(n => {
        pos[n.id].vx += (cx - pos[n.id].x) * 0.01;
        pos[n.id].vy += (cy - pos[n.id].y) * 0.01;
      });
      // integrate + damp
      nodes.forEach(n => {
        pos[n.id].x += pos[n.id].vx * 0.5;
        pos[n.id].y += pos[n.id].vy * 0.5;
        pos[n.id].vx *= 0.6;
        pos[n.id].vy *= 0.6;
        pos[n.id].x = Math.max(30, Math.min(w - 30, pos[n.id].x));
        pos[n.id].y = Math.max(30, Math.min(h - 30, pos[n.id].y));
      });
    }

    const snap: Record<string, { x: number; y: number }> = {};
    nodes.forEach(n => { snap[n.id] = { x: pos[n.id].x, y: pos[n.id].y }; });
    setPositions(snap);
  }, [nodes, edges, w, h]);

  return positions;
}

function CollabGraph({ nodes, edges }: { nodes: TeamNode[]; edges: TeamEdge[] }) {
  const W = 680, H = 420;
  const positions = useForceLayout(nodes, edges, W, H);
  const [hovered, setHovered] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!nodes.length) {
    return (
      <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 13 }}>
        no collaboration data
      </div>
    );
  }

  const maxCommits = Math.max(...nodes.map(n => n.commit_count), 1);
  const maxWeight = Math.max(...edges.map(e => e.weight), 1);
  const adjSet = new Set(
    hovered
      ? edges.filter(e => e.source === hovered || e.target === hovered).flatMap(e => [e.source, e.target])
      : []
  );

  return (
    <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      {edges.map((e, i) => {
        const a = positions[e.source], b = positions[e.target];
        if (!a || !b) return null;
        const isActive = hovered && (e.source === hovered || e.target === hovered);
        const faded = hovered && !isActive;
        const opacity = faded ? 0.08 : 0.35 + (e.weight / maxWeight) * 0.45;
        const w = 0.5 + (e.weight / maxWeight) * 2.5;
        return (
          <line key={i}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={isActive ? "var(--accent)" : "var(--border-bright)"}
            strokeWidth={isActive ? w + 1 : w}
            opacity={opacity}
          />
        );
      })}
      {nodes.map(n => {
        const p = positions[n.id];
        if (!p) return null;
        const r = 6 + (n.commit_count / maxCommits) * 14;
        const isSilo = (n.betweenness ?? 0) > 0.3;
        const isHov = hovered === n.id;
        const isAdj = adjSet.has(n.id);
        const faded = hovered && !isHov && !isAdj;
        return (
          <g key={n.id} style={{ cursor: "pointer" }}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}>
            <circle
              cx={p.x} cy={p.y} r={r + 4}
              fill="transparent"
            />
            <circle
              cx={p.x} cy={p.y} r={r}
              fill={isSilo ? "rgba(255,204,0,0.15)" : "var(--accent-bg)"}
              stroke={isHov ? "var(--accent)" : isSilo ? "var(--warning)" : "var(--accent-border)"}
              strokeWidth={isHov ? 2 : 1.5}
              opacity={faded ? 0.2 : 1}
            />
            <text
              x={p.x} y={p.y + r + 14}
              textAnchor="middle"
              fontSize={10}
              fill={faded ? "var(--border-bright)" : isHov ? "var(--text-h)" : "var(--text-muted)"}
              fontFamily="var(--mono)"
            >
              {n.id.length > 12 ? n.id.slice(0, 11) + "…" : n.id}
            </text>
            {isHov && (
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={9} fill="var(--accent)" fontFamily="var(--mono)">
                {n.commit_count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function Team() {
  const { repoId } = useParams<{ repoId: string }>();
  const [nodes, setNodes] = useState<TeamNode[]>([]);
  const [edges, setEdges] = useState<TeamEdge[]>([]);
  const [busFactor, setBusFactor] = useState<BusFactor | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoId) return;
    Promise.all([
      apiFetch<{ nodes: TeamNode[]; edges: TeamEdge[] }>(`${API_BASE_URL}/repos/${repoId}/team/graph`),
      apiFetch<BusFactor>(`${API_BASE_URL}/repos/${repoId}/team/bus-factor`),
    ]).then(([graph, bf]) => {
      if (graph) { setNodes(graph.nodes ?? []); setEdges(graph.edges ?? []); }
      if (bf) setBusFactor(bf);
      setLoading(false);
    });
  }, [repoId]);

  const bfScore = busFactor ? (busFactor.overall_bus_factor * 100).toFixed(0) : "—";
  const bfColor = riskLevelColor(busFactor?.risk_level ?? "");
  const maxShare = busFactor ? Math.max(...busFactor.contributors.map(c => c.share), 0.01) : 1;

  return (
    <Layout activeNav="team" repoId={repoId}>
      <div style={{ padding: "32px 36px", maxWidth: 1100, overflowY: "auto", height: "100%", boxSizing: "border-box" }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontFamily: "var(--heading)", fontSize: 28, fontWeight: 700, color: "var(--text-h)", margin: "0 0 4px", letterSpacing: "-0.5px" }}>
            Team Intelligence
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            Collaboration patterns, knowledge concentration, and bus factor analysis
          </p>
        </div>

        {/* Stats row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em" }}>CONTRIBUTORS</div>
            <div style={{ color: "var(--text-h)", fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700 }}>
              {loading ? "—" : nodes.length}
            </div>
          </div>
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 4 }}>BUS FACTOR (HHI) <Tooltip text="How concentrated code knowledge is. A score near 1.0 means one person owns most of the codebase — if they leave, the team loses critical context. Lower is healthier." position="bottom" /></div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ color: bfColor, fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700 }}>{bfScore}</span>
              {busFactor && (
                <span style={{
                  background: `${bfColor}18`,
                  border: `1px solid ${bfColor}44`,
                  color: bfColor,
                  borderRadius: 3,
                  padding: "2px 7px",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  letterSpacing: "0.05em",
                }}>
                  {busFactor.risk_level.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 4 }}>COLLAB EDGES <Tooltip text="Number of file-overlap connections between contributors. A higher number means more shared ownership — knowledge is better distributed across the team." position="bottom" /></div>
            <div style={{ color: "var(--text-h)", fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700 }}>
              {loading ? "—" : edges.length}
            </div>
          </div>
        </div>

        {/* Collaboration graph */}
        <div style={{ ...card, marginBottom: 24, padding: "20px 20px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em" }}>DEVELOPER COLLABORATION GRAPH</div>
            <div style={{ display: "flex", gap: 16, fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)" }}>
              <span><span style={{ color: "var(--accent)" }}>●</span> contributor</span>
              <span><span style={{ color: "var(--warning)" }}>●</span> knowledge silo</span>
            </div>
          </div>
          {loading
            ? <div style={{ height: 420, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>loading…</div>
            : <CollabGraph nodes={nodes} edges={edges} />
          }
          <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginTop: 8 }}>
            node size = commit count · amber = high betweenness (knowledge silo risk) · hover to inspect
          </div>
        </div>

        {/* Bus factor + recommendations */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

          {/* Top contributors */}
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 16 }}>TOP CONTRIBUTORS</div>
            {!busFactor ? (
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>{loading ? "loading…" : "no data"}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {busFactor.contributors.slice(0, 7).map((c, i) => (
                  <div key={c.name}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ color: "var(--text-h)", fontSize: 13 }}>
                        <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginRight: 8 }}>#{i + 1}</span>
                        {c.name}
                      </span>
                      <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>
                        {(c.share * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{
                        height: "100%",
                        width: `${(c.share / maxShare) * 100}%`,
                        background: i === 0 && c.share > 0.4 ? "var(--danger)" : i < 2 ? "var(--warning)" : "var(--accent)",
                        borderRadius: 2,
                        transition: "width 0.4s ease",
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recommendations */}
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 16 }}>RECOMMENDATIONS</div>
            {!busFactor ? (
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>{loading ? "loading…" : "no data"}</div>
            ) : busFactor.recommendations.length === 0 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 13 }}>
                <span>✓</span> No critical recommendations
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {busFactor.recommendations.map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 10 }}>
                    <span style={{
                      flexShrink: 0,
                      width: 20,
                      height: 20,
                      background: "var(--accent-bg)",
                      border: "1px solid var(--accent-border)",
                      color: "var(--accent)",
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      borderRadius: 3,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.55 }}>{r}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </Layout>
  );
}
