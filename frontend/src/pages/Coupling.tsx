import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../lib/apiConfig';
import Layout from '../components/Layout';
import Tooltip from '../components/Tooltip';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────

interface CouplingNode { id: string; group: number }
interface CouplingLink { source: string; target: string; value: number }

// ── Helpers ───────────────────────────────────────────────────────────────

const authHdr = () => ({ Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` });

async function apiFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHdr() });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

function shortName(id: string): string {
  const part = id.includes('/') ? id.split('/').pop()! : id;
  return part.length > 18 ? part.slice(0, 16) + '…' : part;
}

// Group → color mapping (accent tones)
const GROUP_COLORS = [
  '#00ff41', '#4ec9b0', '#ffcc00', '#ff9944', '#c792ea',
  '#82aaff', '#ff5572', '#89ddff', '#addb67', '#f78c6c',
];

function groupColor(g: number): string {
  return GROUP_COLORS[g % GROUP_COLORS.length];
}

// ── Coupling Graph SVG ────────────────────────────────────────────────────

interface GraphProps {
  nodes: CouplingNode[];
  links: CouplingLink[];
}

const CouplingGraphSVG: React.FC<GraphProps> = ({ nodes, links }) => {
  const [hovered, setHovered] = useState<string | null>(null);

  const W = 700, H = 480;
  const cx = W / 2, cy = H / 2;

  // Radial layout — spread nodes in a circle, inner nodes for high-degree
  const R = Math.min(cx, cy) - 70;

  const positions: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    positions[n.id] = {
      x: cx + R * Math.cos(angle),
      y: cy + R * Math.sin(angle),
    };
  });

  // Adjacency for hover highlight
  const adjacent = useCallback((id: string): Set<string> => {
    const s = new Set<string>();
    links.forEach(l => {
      if (l.source === id) s.add(l.target);
      if (l.target === id) s.add(l.source);
    });
    return s;
  }, [links]);

  const adj = hovered ? adjacent(hovered) : null;

  const sortedLinks = [...links].sort((a, b) => a.value - b.value);

  if (!nodes.length) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 300, fontFamily: 'var(--mono)', fontSize: '0.78rem',
        color: 'var(--text-muted)', letterSpacing: '0.08em',
      }}>
        NO_COUPLING_DATA // trigger backfill to compute
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', display: 'block', background: 'var(--code-bg)', borderRadius: 3 }}
    >
      {/* Links */}
      {sortedLinks.map((l, i) => {
        const s = positions[l.source];
        const t = positions[l.target];
        if (!s || !t) return null;

        const isActive = !hovered || l.source === hovered || l.target === hovered;
        const strength = Math.max(0.5, l.value * 6);
        const opacity  = hovered
          ? (l.source === hovered || l.target === hovered ? 0.85 : 0.06)
          : Math.max(0.15, l.value * 0.8);

        const linkColor = l.value >= 0.6 ? 'var(--danger)' : l.value >= 0.35 ? 'var(--warning)' : 'var(--accent)';

        return (
          <line
            key={i}
            x1={s.x} y1={s.y} x2={t.x} y2={t.y}
            stroke={isActive ? linkColor : 'var(--border)'}
            strokeWidth={isActive ? strength : 0.5}
            strokeOpacity={opacity}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map(n => {
        const p = positions[n.id];
        if (!p) return null;
        const color   = groupColor(n.group);
        const isHov   = hovered === n.id;
        const isAdj   = adj?.has(n.id);
        const faded   = hovered && !isHov && !isAdj;
        const radius  = isHov ? 11 : 8;

        // Label positioning — push outward from center
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const lx = p.x + (dx / dist) * 22;
        const ly = p.y + (dy / dist) * 22;
        const anchor = dx > 10 ? 'start' : dx < -10 ? 'end' : 'middle';

        return (
          <g
            key={n.id}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
          >
            {/* Glow ring on hover */}
            {isHov && (
              <circle cx={p.x} cy={p.y} r={radius + 5} fill="none" stroke={color} strokeWidth={1} strokeOpacity={0.35} />
            )}
            <circle
              cx={p.x} cy={p.y} r={radius}
              fill={color}
              fillOpacity={faded ? 0.15 : isHov ? 1 : 0.8}
            />
            <text
              x={lx} y={ly + 3}
              textAnchor={anchor}
              fontSize={faded ? 0 : isHov || isAdj ? 11 : 9}
              fill={isHov ? color : isAdj ? 'var(--text)' : 'var(--text-muted)'}
              fontFamily="var(--mono)"
            >
              {shortName(n.id)}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ── Main Page ─────────────────────────────────────────────────────────────

const Coupling: React.FC = () => {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate   = useNavigate();

  const [nodes,   setNodes]   = useState<CouplingNode[]>([]);
  const [links,   setLinks]   = useState<CouplingLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState('');

  useEffect(() => {
    if (!localStorage.getItem('token')) { navigate('/'); return; }
    if (!repoId) { navigate('/home'); return; }
    apiFetch<{ nodes: CouplingNode[]; links: CouplingLink[] }>(
      `${API_BASE_URL}/repos/${repoId}/coupling`
    ).then(data => {
      if (data) {
        setNodes(data.nodes);
        setLinks(data.links);
        if (!data.nodes.length) toast.info('No coupling data yet — sync more commits to see patterns.');
      } else {
        toast.error('Failed to load coupling data.');
      }
    }).finally(() => setLoading(false));
  }, [repoId, navigate]);

  const sortedLinks  = [...links].sort((a, b) => b.value - a.value);
  const strongLinks  = links.filter(l => l.value >= 0.6);
  const groups       = new Set(nodes.map(n => n.group)).size;

  const filteredLinks = sortedLinks.filter(l =>
    !search ||
    l.source.toLowerCase().includes(search.toLowerCase()) ||
    l.target.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Layout activeNav="coupling" repoId={repoId}>
      {/* Top bar */}
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '0 2rem', height: 52,
        position: 'sticky', top: 0, zIndex: 10, flexShrink: 0,
      }}>
        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
          FILE COUPLING ANALYSIS
        </span>
        <span style={{ color: 'var(--border-bright)' }}>//</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
          files that change together
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <div style={{ width: 30, height: 30, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>USR</div>
        </div>
      </header>

      <main style={{ flex: 1, padding: '2rem 2.5rem 3rem', overflowY: 'auto' }}>

        {/* Hero */}
        <div style={{ marginBottom: '1.75rem', lineHeight: 0.9 }}>
          <div style={{ fontFamily: 'var(--heading)', fontSize: 'clamp(2.8rem, 6vw, 4.5rem)', fontWeight: 700, color: 'var(--text-h)', textTransform: 'uppercase', letterSpacing: '-0.02em' }}>
            FILE_COUPLING
          </div>
          <div style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.75rem', maxWidth: 560, lineHeight: 1.5, lineHeight: 1.5 }}>
            Files that are frequently changed together in the same commit. When two files are tightly coupled, a bug fix or feature in one almost always requires a change in the other — a hidden dependency worth knowing about.
          </div>
        </div>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="skeleton" style={{ height: 60, borderRadius: 3 }} />
            <div className="skeleton" style={{ height: 480, borderRadius: 3 }} />
          </div>
        ) : (
          <>
            {/* Stats row */}
            <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {[
                { label: 'TOTAL FILES',      value: nodes.length,        tip: 'Files that appear in at least one co-change pair. Files changed alone every time are excluded.' },
                { label: 'COUPLED PAIRS',    value: links.length,        tip: 'Number of file pairs that have been committed together at least 10% of the time.' },
                { label: 'STRONG COUPLINGS', value: strongLinks.length,  accent: strongLinks.length > 0, tip: 'Pairs with very high coupling (score > 0.7). Changing one almost certainly means you need to change the other.' },
                { label: 'FILE CLUSTERS',    value: groups,              tip: 'Groups of files that tend to change together. Each cluster is a hidden module — changes in one file may ripple through the whole group.' },
              ].map(s => (
                <div key={s.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1rem 1.25rem' }}>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                    {s.label}
                    {s.tip && <Tooltip text={s.tip} position="bottom" />}
                  </div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '2rem', fontWeight: 700, color: s.accent ? 'var(--warning)' : 'var(--text-h)', letterSpacing: '-0.02em' }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Graph */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1.25rem', marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    COUPLING GRAPH
                  </div>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    Hover node to highlight connections · thicker lines = stronger coupling
                  </div>
                </div>
                {/* Legend */}
                <div style={{ display: 'flex', gap: '1rem' }}>
                  {[
                    { color: 'var(--accent)',  label: 'Weak  <35%' },
                    { color: 'var(--warning)', label: 'Moderate 35–60%' },
                    { color: 'var(--danger)',  label: 'Strong >60%' },
                  ].map(l => (
                    <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <div style={{ width: 24, height: 2, background: l.color, borderRadius: 1 }} />
                      <span style={{ fontFamily: 'var(--sans)', fontSize: '0.62rem', color: 'var(--text-muted)' }}>{l.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <CouplingGraphSVG nodes={nodes} links={links} />
            </div>

            {/* Top pairs table */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  TOP COUPLED PAIRS
                </span>
                <input
                  type="text"
                  placeholder="filter files..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3,
                    color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.7rem',
                    padding: '0.3rem 0.65rem', outline: 'none', width: 180,
                  }}
                  onFocus={e => (e.target.style.borderColor = 'var(--accent-border)')}
                  onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                />
              </div>

              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 180px', padding: '0.6rem 1.5rem', borderBottom: '1px solid var(--border)', gap: '1rem' }}>
                {['SOURCE FILE', 'TARGET FILE', 'COUPLING SCORE'].map(h => (
                  <span key={h} style={{ fontFamily: 'var(--sans)', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{h}</span>
                ))}
              </div>

              {filteredLinks.length === 0 ? (
                <div style={{ padding: '2.5rem', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                  NO_PAIRS_FOUND //
                </div>
              ) : (
                filteredLinks.slice(0, 25).map((l, i) => {
                  const pct   = Math.round(l.value * 100);
                  const color = l.value >= 0.6 ? 'var(--danger)' : l.value >= 0.35 ? 'var(--warning)' : 'var(--accent)';
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr 180px',
                        padding: '0.75rem 1.5rem', gap: '1rem', alignItems: 'center',
                        borderBottom: i < Math.min(filteredLinks.length, 25) - 1 ? '1px solid var(--border)' : 'none',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-raised)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                    >
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.source}
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.target}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{ flex: 1, height: 4, background: 'var(--surface-raised)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', background: color, borderRadius: 2, width: `${Math.min(pct, 100)}%`, transition: 'width 0.3s ease' }} />
                        </div>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color, minWidth: 32, textAlign: 'right' }}>{pct}%</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </main>
    </Layout>
  );
};

export default Coupling;
