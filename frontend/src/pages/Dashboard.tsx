import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as d3 from 'd3';
import { API_BASE_URL, WS_BASE_URL } from '../lib/apiConfig';

// ── Types ─────────────────────────────────────────────────────────────────

interface RepoData { id: string; name: string; owner: string; synced_at: string; stats?: { commits: number; pull_requests: number } }
interface FileData { path: string; language: string; lines: number; risk_score: number; changes?: number; violations: string[] }
interface PRData { id: string; number: number; title: string; state: string; author_login: string; created_at: string; merged_at?: string; predicted_risk_score?: number; repo_id: string }
interface RiskData { score: number; label: string; breakdown: Record<string, number>; weights?: Record<string, number> }
interface DoraData { deployment_frequency: { value: number; rating: string; label: string }; lead_time_for_changes: { value: number; rating: string; label: string }; change_failure_rate: { value: number; rating: string; label: string }; time_to_restore: { value: number | null; rating: string; label: string } }
interface FlakyTest { ci_run_id: string; run_name: string; head_sha: string; conclusion: string; flakiness_prob: number; total_errors: number; failure_signatures: { template: string; count: number }[]; created_at: string }
interface TeamNode { id: string; commit_count: number; betweenness?: number }
interface TeamEdge { source: string; target: string; weight: number }
interface BusFactor { overall_bus_factor: number; risk_level: string; contributors: { name: string; share: number; weighted_commits: number }[]; recommendations: string[] }
interface ChatMessage { role: 'user' | 'assistant'; content: string }
interface CouplingNode { id: string; group: number }
interface CouplingLink { source: string; target: string; value: number }
interface ScoreHistoryPoint { recorded_at: string; score: number; label: string }
interface FileDetail {
  path: string;
  churn_history: { week: string; additions: number; deletions: number }[];
  ownership: { contributor: string; commits: number; share: number }[];
  coupling_rules: { file: string; score: number }[];
  violations: { type: string; severity: string; description: string; line: number }[];
}
interface PRExplanation { summary: string; root_causes?: string[]; mitigation_steps?: string[]; actions?: { type: string; file: string | null; description: string }[] }

type Tab = 'overview' | 'files' | 'prs' | 'coupling' | 'releases' | 'ci' | 'team' | 'settings';

// ── Helpers ───────────────────────────────────────────────────────────────

const riskColor  = (s: number) => s >= 75 ? 'text-red-600'    : s >= 55 ? 'text-orange-500' : s >= 30 ? 'text-yellow-600' : 'text-green-600';
const riskBg     = (s: number) => s >= 75 ? 'bg-red-100 text-red-800'    : s >= 55 ? 'bg-orange-100 text-orange-800' : s >= 30 ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800';
const ratingColor = (r: string) => ({ elite: 'text-green-600', high: 'text-blue-600', medium: 'text-yellow-600', low: 'text-red-600', unknown: 'text-gray-400' }[r] ?? 'text-gray-400');
const ratingBg    = (r: string) => ({ elite: 'bg-green-100 text-green-800', high: 'bg-blue-100 text-blue-800', medium: 'bg-yellow-100 text-yellow-800', low: 'bg-red-100 text-red-800', unknown: 'bg-gray-100 text-gray-600' }[r] ?? 'bg-gray-100 text-gray-600');

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` });

async function apiFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// ── Sub-components ────────────────────────────────────────────────────────

const StatCard: React.FC<{ label: string; value: string | number; sub?: string }> = ({ label, value, sub }) => (
  <div className="bg-white rounded-lg shadow p-5">
    <p className="text-sm text-gray-500">{label}</p>
    <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
  </div>
);

const RiskBar: React.FC<{ label: string; value: number; max?: number }> = ({ label, value, max = 100 }) => (
  <div>
    <div className="flex justify-between text-sm mb-1">
      <span className="text-gray-600 capitalize">{label.replace(/_/g, ' ')}</span>
      <span className={riskColor(value)}>{value}/{max}</span>
    </div>
    <div className="w-full bg-gray-100 rounded-full h-2">
      <div className={`h-2 rounded-full ${value >= 75 ? 'bg-red-500' : value >= 55 ? 'bg-orange-400' : value >= 30 ? 'bg-yellow-400' : 'bg-green-500'}`}
           style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  </div>
);

const DoraCard: React.FC<{ title: string; value: number | null; unit: string; rating: string; label: string }> = ({ title, value, unit, rating, label }) => (
  <div className="bg-white rounded-lg shadow p-5">
    <p className="text-sm text-gray-500">{title}</p>
    <p className="text-2xl font-bold text-gray-900 mt-1">
      {value !== null && value !== undefined ? `${value} ${unit}` : '—'}
    </p>
    <span className={`inline-block mt-2 px-2 py-0.5 rounded-full text-xs font-medium ${ratingBg(rating)}`}>
      {rating.toUpperCase()}
    </span>
    <p className="text-xs text-gray-400 mt-1">{label}</p>
  </div>
);

// ── Score Sparkline ───────────────────────────────────────────────────────

const ScoreSparkline: React.FC<{ history: ScoreHistoryPoint[] }> = ({ history }) => {
  if (history.length < 2) return <p className="text-xs text-gray-400 mt-2">Trend data accumulating…</p>;
  const W = 200, H = 40, pad = 4;
  const scores = history.map(h => h.score);
  const minS = Math.min(...scores), maxS = Math.max(...scores);
  const range = maxS - minS || 1;
  const points = history.map((h, i) => {
    const x = pad + (i / (history.length - 1)) * (W - pad * 2);
    const y = H - pad - ((h.score - minS) / range) * (H - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  const trend = scores[scores.length - 1] - scores[0];
  const trendColor = trend > 5 ? '#ef4444' : trend < -5 ? '#22c55e' : '#6b7280';
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-gray-400">30-day trend</span>
        <span className="text-xs font-medium" style={{ color: trendColor }}>{trend > 0 ? '+' : ''}{trend.toFixed(0)} pts</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }} className="w-full">
        <polyline points={points} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

// ── Ownership Pie ─────────────────────────────────────────────────────────

const PIE_COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#f59e0b'];

const OwnershipPie: React.FC<{ ownership: FileDetail['ownership'] }> = ({ ownership }) => {
  if (!ownership.length) return <p className="text-xs text-gray-400">No ownership data.</p>;
  const total = ownership.reduce((s, o) => s + o.commits, 0) || 1;
  let angle = -Math.PI / 2;
  const cx = 80, cy = 80, r = 70;
  return (
    <svg viewBox="0 0 240 170" className="w-full max-w-xs">
      {ownership.slice(0, 7).map((o, i) => {
        const frac = o.commits / total;
        const sweep = frac * 2 * Math.PI;
        const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
        angle += sweep;
        const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
        const large = sweep > Math.PI ? 1 : 0;
        const path = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`;
        return <path key={i} d={path} fill={PIE_COLORS[i % PIE_COLORS.length]} fillOpacity={0.85} stroke="white" strokeWidth={1.5} />;
      })}
      {ownership.slice(0, 5).map((o, i) => (
        <g key={i}>
          <rect x={168} y={12 + i * 28} width={10} height={10} fill={PIE_COLORS[i % PIE_COLORS.length]} rx={2} />
          <text x={183} y={21 + i * 28} fontSize={9} fill="#374151">{o.contributor.slice(0, 12)} ({(o.share * 100).toFixed(0)}%)</text>
        </g>
      ))}
    </svg>
  );
};

// ── D3 Team Graph ─────────────────────────────────────────────────────────

type D3Node = d3.SimulationNodeDatum & TeamNode;
type D3Link = d3.SimulationLinkDatum<D3Node> & { weight: number };

const TeamGraph: React.FC<{ nodes: TeamNode[]; edges: TeamEdge[] }> = ({ nodes, edges }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: TeamNode } | null>(null);

  useEffect(() => {
    if (!nodes.length || !svgRef.current) return;
    const W = 640, H = 420;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    // Silo detection via BFS
    const adj: Record<string, Set<string>> = {};
    nodes.forEach(n => { adj[n.id] = new Set(); });
    edges.forEach(e => { adj[e.source]?.add(e.target); adj[e.target]?.add(e.source); });
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const node of nodes) {
      if (visited.has(node.id)) continue;
      const comp: string[] = [];
      const queue = [node.id];
      while (queue.length) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur); comp.push(cur);
        adj[cur]?.forEach(nb => { if (!visited.has(nb)) queue.push(nb); });
      }
      components.push(comp);
    }
    const largestComp = new Set(components.reduce((a, b) => a.length >= b.length ? a : b, []));

    const maxCommits = Math.max(...nodes.map(n => n.commit_count), 1);
    const maxB = Math.max(...nodes.map(n => n.betweenness ?? 0), 0.001);
    const colorScale = d3.scaleSequential(d3.interpolateBlues).domain([0, maxB]);

    const simNodes: D3Node[] = nodes.map(n => ({ ...n }));
    const nodeById = new Map(simNodes.map(n => [n.id, n]));
    const simLinks: D3Link[] = edges
      .map(e => ({ source: nodeById.get(e.source) ?? e.source, target: nodeById.get(e.target) ?? e.target, weight: e.weight }));

    const simulation = d3.forceSimulation(simNodes)
      .force('link', d3.forceLink<D3Node, D3Link>(simLinks).strength(0.3).distance(100))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collision', d3.forceCollide<D3Node>().radius(d => 8 + (d.commit_count / maxCommits) * 14 + 4));

    const linkSel = svg.append('g').selectAll<SVGLineElement, D3Link>('line').data(simLinks).join('line')
      .attr('stroke', '#93c5fd').attr('stroke-opacity', 0.6).attr('stroke-width', d => Math.min(d.weight, 4));

    const nodeSel = svg.append('g').selectAll<SVGCircleElement, D3Node>('circle').data(simNodes).join('circle')
      .attr('r', d => 8 + (d.commit_count / maxCommits) * 14)
      .attr('fill', d => largestComp.has(d.id) ? colorScale(d.betweenness ?? 0) : '#f59e0b')
      .attr('fill-opacity', 0.85)
      .attr('stroke', d => largestComp.has(d.id) ? '#2563eb' : '#d97706')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mouseenter', (event: MouseEvent, d: D3Node) => {
        const rect = svgRef.current!.getBoundingClientRect();
        setTooltip({ x: event.clientX - rect.left, y: event.clientY - rect.top, node: d });
      })
      .on('mouseleave', () => setTooltip(null));

    const labelSel = svg.append('g').selectAll<SVGTextElement, D3Node>('text').data(simNodes).join('text')
      .attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', '#374151')
      .text(d => d.id.length > 12 ? d.id.slice(0, 10) + '…' : d.id);

    simulation.on('tick', () => {
      linkSel
        .attr('x1', d => (d.source as D3Node).x ?? 0).attr('y1', d => (d.source as D3Node).y ?? 0)
        .attr('x2', d => (d.target as D3Node).x ?? 0).attr('y2', d => (d.target as D3Node).y ?? 0);
      nodeSel.attr('cx', d => d.x ?? 0).attr('cy', d => d.y ?? 0);
      labelSel.attr('x', d => d.x ?? 0).attr('y', d => (d.y ?? 0) + (8 + (d.commit_count / maxCommits) * 14) + 14);
    });

    return () => { simulation.stop(); };
  }, [nodes, edges]);

  if (!nodes.length) return <p className="text-gray-400 text-center py-8">No developer data yet.</p>;

  return (
    <div className="relative">
      <svg ref={svgRef} viewBox="0 0 640 420" className="w-full max-w-2xl mx-auto" />
      {tooltip && (
        <div className="absolute bg-gray-900 text-white text-xs rounded px-2 py-1.5 pointer-events-none z-10 shadow-lg"
             style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}>
          <p className="font-semibold">{tooltip.node.id}</p>
          <p>{tooltip.node.commit_count} commits</p>
          {tooltip.node.betweenness != null && <p>Centrality: {(tooltip.node.betweenness * 100).toFixed(1)}%</p>}
        </div>
      )}
      <div className="flex gap-4 mt-2 text-xs text-gray-500 justify-center">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-blue-400" /> High centrality</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-amber-400" /> Knowledge silo</span>
      </div>
    </div>
  );
};

// ── Coupling Graph ────────────────────────────────────────────────────────

const CouplingGraph: React.FC<{ nodes: CouplingNode[]; links: CouplingLink[] }> = ({ nodes, links }) => {
  if (!nodes.length) return <p className="text-gray-400 text-center py-8">No coupling data yet. Sync a repo with commit history.</p>;
  const W = 640, H = 420, cx = W / 2, cy = H / 2, R = 170;
  const positions: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    positions[n.id] = { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl mx-auto">
      {links.map((l, i) => {
        const s = positions[l.source], t = positions[l.target];
        if (!s || !t) return null;
        return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#f97316" strokeWidth={Math.max(1, l.value * 6)} strokeOpacity={0.5} />;
      })}
      {nodes.map(n => {
        const p = positions[n.id];
        if (!p) return null;
        const short = n.id.includes('/') ? n.id.split('/').pop()! : n.id;
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={8} fill="#f97316" fillOpacity={0.85} />
            <text x={p.x} y={p.y + 20} textAnchor="middle" fontSize={10} fill="#374151">
              {short.length > 16 ? short.slice(0, 14) + '…' : short}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ── Main Dashboard ────────────────────────────────────────────────────────

const Dashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [repoData,      setRepoData]      = useState<RepoData | null>(null);
  const [filesData,     setFilesData]     = useState<FileData[]>([]);
  const [prsData,       setPrsData]       = useState<PRData[]>([]);
  const [riskData,      setRiskData]      = useState<RiskData | null>(null);
  const [doraData,      setDoraData]      = useState<DoraData | null>(null);
  const [flakyData,     setFlakyData]     = useState<FlakyTest[]>([]);
  const [teamNodes,     setTeamNodes]     = useState<TeamNode[]>([]);
  const [teamEdges,     setTeamEdges]     = useState<TeamEdge[]>([]);
  const [busFactor,     setBusFactor]     = useState<BusFactor | null>(null);
  const [couplingNodes, setCouplingNodes] = useState<CouplingNode[]>([]);
  const [couplingLinks, setCouplingLinks] = useState<CouplingLink[]>([]);
  const [scoreHistory,  setScoreHistory]  = useState<ScoreHistoryPoint[]>([]);
  const [repoConfig,    setRepoConfig]    = useState<Record<string, number>>({ coupling: 0.25, architecture: 0.20, bus_factor: 0.20, collaboration: 0.15, ci: 0.20 });

  // PR detail panel
  const [selectedPR,       setSelectedPR]       = useState<PRData | null>(null);
  const [prDetail,         setPrDetail]         = useState<{ comments: { id: string; author_login: string; body: string }[] } | null>(null);
  const [prDetailLoading,  setPrDetailLoading]  = useState(false);
  const [prExplainData,    setPrExplainData]    = useState<PRExplanation | null>(null);
  const [prExplainLoading, setPrExplainLoading] = useState(false);

  // File detail panel
  const [selectedFile,      setSelectedFile]      = useState<FileData | null>(null);
  const [fileDetail,        setFileDetail]        = useState<FileDetail | null>(null);
  const [fileDetailLoading, setFileDetailLoading] = useState(false);

  // Settings extras
  const [archPolicy,       setArchPolicy]       = useState('');
  const [archPolicySaving, setArchPolicySaving] = useState(false);
  const [archPolicyError,  setArchPolicyError]  = useState<string | null>(null);
  const [policyGenerating, setPolicyGenerating] = useState(false);
  const [blockThreshold,   setBlockThreshold]   = useState(75);
  const [warnOnly,         setWarnOnly]         = useState(false);
  const [llmProvider,      setLlmProvider]      = useState('gemini');
  const [llmApiKey,        setLlmApiKey]        = useState('');
  const [notifSaving,      setNotifSaving]      = useState(false);

  const [loading,            setLoading]            = useState(true);
  const [progress,           setProgress]           = useState<{ status: string; details?: string }>({ status: 'Connecting…' });
  const [triggeringBackfill, setTriggeringBackfill] = useState(false);
  const [backfillMsg,        setBackfillMsg]        = useState<string | null>(null);

  const [chatOpen,    setChatOpen]    = useState(false);
  const [chatInput,   setChatInput]   = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const location = useLocation();
  const navigate = useNavigate();
  const repoId = location.state?.repoId;

  useEffect(() => {
    if (!repoId) return;
    const ws = new WebSocket(`${WS_BASE_URL}/ws/repos/${repoId}/live`);
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'pr_scored') {
        setPrsData(prev => prev.map(pr => pr.id === data.pr_id ? { ...pr, predicted_risk_score: data.score } : pr));
      }
    };
    return () => ws.close();
  }, [repoId]);

  useEffect(() => {
    if (!repoId) { setLoading(false); return; }
    loadAll();
    const ws = new WebSocket(`${WS_BASE_URL}/ws/progress/${repoId}`);
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      setProgress(data);
      if (data.status === 'complete') { ws.close(); loadAll(); }
    };
    return () => ws.close();
  }, [repoId]);

  const loadAll = useCallback(async () => {
    if (!repoId) return;
    const token = localStorage.getItem('token');
    if (!token) { navigate('/login'); return; }
    setLoading(true);
    try {
      const [repo, files, prs, risk, dora, flaky, team, bf, coupling, history] = await Promise.all([
        apiFetch<RepoData>(`${API_BASE_URL}/repos/${repoId}`),
        apiFetch<FileData[]>(`${API_BASE_URL}/repos/${repoId}/files`),
        apiFetch<PRData[]>(`${API_BASE_URL}/prs/?repo_id=${repoId}&limit=50`),
        apiFetch<RiskData>(`${API_BASE_URL}/repos/${repoId}/risk`),
        apiFetch<DoraData>(`${API_BASE_URL}/repos/${repoId}/releases`),
        apiFetch<FlakyTest[]>(`${API_BASE_URL}/repos/${repoId}/tests/flaky`),
        apiFetch<{ nodes: TeamNode[]; edges: TeamEdge[] }>(`${API_BASE_URL}/repos/${repoId}/team/graph`),
        apiFetch<BusFactor>(`${API_BASE_URL}/repos/${repoId}/team/bus-factor`),
        apiFetch<{ nodes: CouplingNode[]; links: CouplingLink[] }>(`${API_BASE_URL}/repos/${repoId}/coupling`),
        apiFetch<ScoreHistoryPoint[]>(`${API_BASE_URL}/repos/${repoId}/score/history?days=30`),
      ]);
      if (repo)     setRepoData(repo);
      if (files)    setFilesData(files);
      if (prs)      setPrsData(prs);
      if (risk)     {
        setRiskData(risk);
        setRepoConfig(risk.weights ?? repoConfig);
        const cfg = (risk as unknown as { config?: Record<string, unknown> }).config ?? {};
        if (cfg.block_threshold != null) setBlockThreshold(cfg.block_threshold as number);
        if (cfg.warn_only != null)       setWarnOnly(cfg.warn_only as boolean);
        if (cfg.llm_provider != null)    setLlmProvider(cfg.llm_provider as string);
        if (cfg.arch_policy != null)     setArchPolicy(JSON.stringify(cfg.arch_policy, null, 2));
      }
      if (dora)     setDoraData(dora);
      if (flaky)    setFlakyData(flaky);
      if (team)     { setTeamNodes(team.nodes); setTeamEdges(team.edges); }
      if (bf)       setBusFactor(bf);
      if (coupling) { setCouplingNodes(coupling.nodes); setCouplingLinks(coupling.links); }
      if (history)  setScoreHistory(history);
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  const triggerBackfill = async () => {
    if (!repoId) return;
    setTriggeringBackfill(true); setBackfillMsg(null);
    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/backfill`, { method: 'POST', headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json())?.detail || 'Failed');
      setBackfillMsg('Backfill queued.');
    } catch (e: unknown) {
      setBackfillMsg(e instanceof Error ? e.message : 'Error');
    } finally { setTriggeringBackfill(false); }
  };

  const saveWeights = async () => {
    if (!repoId) return;
    const total = Object.values(repoConfig).reduce((a, b) => a + b, 0);
    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(repoConfig)) normalized[k] = v / total;
    await fetch(`${API_BASE_URL}/repos/${repoId}`, {
      method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { weights_normalized: normalized } }),
    });
  };

  // ── PR Detail ────────────────────────────────────────────────────────────

  const openPRDetail = async (pr: PRData) => {
    setSelectedPR(pr); setPrDetail(null); setPrExplainData(null);
    setPrDetailLoading(true);
    const detail = await apiFetch<{ comments: { id: string; author_login: string; body: string }[] }>(`${API_BASE_URL}/prs/${pr.id}`);
    setPrDetail(detail); setPrDetailLoading(false);
    setPrExplainLoading(true);
    try {
      const r = await fetch(`${API_BASE_URL}/prs/${pr.id}/explain`, { method: 'POST', headers: authHeaders() });
      if (r.ok) {
        const data = await r.json();
        setPrExplainData(typeof data === 'string' ? { summary: data } : data);
      }
    } finally { setPrExplainLoading(false); }
  };

  // ── File Detail ──────────────────────────────────────────────────────────

  const openFileDetail = async (file: FileData) => {
    setSelectedFile(file); setFileDetail(null); setFileDetailLoading(true);
    const detail = await apiFetch<FileDetail>(`${API_BASE_URL}/repos/${repoId}/files/detail?path=${encodeURIComponent(file.path)}`);
    setFileDetail(detail); setFileDetailLoading(false);
  };

  // ── Settings ─────────────────────────────────────────────────────────────

  const saveArchPolicy = async () => {
    if (!repoId) return;
    setArchPolicyError(null);
    try {
      const parsed = JSON.parse(archPolicy);
      setArchPolicySaving(true);
      await fetch(`${API_BASE_URL}/repos/${repoId}`, {
        method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { arch_policy: parsed } }),
      });
    } catch { setArchPolicyError('Invalid JSON. Fix syntax errors before saving.'); }
    finally { setArchPolicySaving(false); }
  };

  const generatePolicy = async () => {
    if (!repoId) return;
    setPolicyGenerating(true);
    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/policy/generate`, { method: 'POST', headers: authHeaders() });
      if (r.ok) {
        const data = await r.json();
        setArchPolicy(typeof data.policy === 'string' ? data.policy : JSON.stringify(data.policy, null, 2));
      }
    } finally { setPolicyGenerating(false); }
  };

  const saveNotificationPrefs = async () => {
    if (!repoId) return;
    setNotifSaving(true);
    try {
      await fetch(`${API_BASE_URL}/repos/${repoId}`, {
        method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { block_threshold: blockThreshold, warn_only: warnOnly, llm_provider: llmProvider, ...(llmApiKey ? { llm_api_key: llmApiKey } : {}) } }),
      });
    } finally { setNotifSaving(false); }
  };

  const sendChat = async () => {
    if (!chatInput.trim() || !repoId) return;
    const userMsg: ChatMessage = { role: 'user', content: chatInput };
    const newHistory = [...chatHistory, userMsg];
    setChatHistory(newHistory); setChatInput(''); setChatLoading(true);
    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/chat`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: chatInput, history: newHistory.slice(-10).map(m => ({ role: m.role, content: m.content })) }),
      });
      const txt = r.ok ? (await r.json()).response || 'No response.' : 'Error: Could not get a response.';
      setChatHistory(prev => [...prev, { role: 'assistant', content: txt }]);
    } catch { setChatHistory(prev => [...prev, { role: 'assistant', content: 'Network error.' }]); }
    finally { setChatLoading(false); setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto" />
          <p className="mt-4 text-gray-600">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' }, { key: 'files', label: 'Files' },
    { key: 'prs', label: 'Pull Requests' }, { key: 'coupling', label: 'Coupling' },
    { key: 'releases', label: 'Releases' }, { key: 'ci', label: 'CI / Tests' },
    { key: 'team', label: 'Team' }, { key: 'settings', label: 'Settings' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 relative">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">RepoLens</h1>
              {repoData && <p className="text-sm text-gray-500">{repoData.owner}/{repoData.name}</p>}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setChatOpen(o => !o)}
                      className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">
                {chatOpen ? 'Close Chat' : '💬 AI Assistant'}
              </button>
              <button onClick={() => navigate('/setup')}
                      className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">
                Switch Repo
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Tabs */}
        <div className="border-b border-gray-200 mb-6">
          <nav className="-mb-px flex space-x-6 overflow-x-auto">
            {tabs.map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                      className={`py-2 px-1 border-b-2 text-sm font-medium whitespace-nowrap ${
                        activeTab === t.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}>
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {repoData && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Commits"       value={repoData.stats?.commits ?? 0} />
                <StatCard label="Pull Requests" value={repoData.stats?.pull_requests ?? 0} />
                <StatCard label="Open PRs"      value={prsData.filter(p => p.state === 'OPEN').length} />
                <StatCard label="Last Synced"   value={repoData.synced_at ? new Date(repoData.synced_at).toLocaleDateString() : 'Never'} />
              </div>
            )}
            {riskData && (
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Unified Risk Score</h2>
                    <span className={`inline-block mt-1 px-3 py-1 rounded-full text-sm font-medium ${riskBg(riskData.score)}`}>
                      {riskData.label.toUpperCase()}
                    </span>
                    <ScoreSparkline history={scoreHistory} />
                  </div>
                  <span className={`text-4xl font-bold ${riskColor(riskData.score)}`}>{riskData.score}/100</span>
                </div>
                <div className="space-y-3 mt-2">
                  {Object.entries(riskData.breakdown).map(([k, v]) => <RiskBar key={k} label={k} value={v} />)}
                </div>
              </div>
            )}
            {repoId && progress.status !== 'complete' && (
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-base font-medium text-gray-900 mb-3">Sync Status</h3>
                <p className="text-sm text-gray-700 mb-1">{progress.status}</p>
                {progress.details && <p className="text-xs text-gray-400 mb-3">{progress.details}</p>}
                <button onClick={triggerBackfill} disabled={triggeringBackfill}
                        className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
                  {triggeringBackfill ? 'Triggering…' : 'Trigger Backfill'}
                </button>
                {backfillMsg && <p className="text-xs text-gray-500 mt-2">{backfillMsg}</p>}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white rounded-lg shadow p-5">
                <h3 className="text-sm font-medium text-gray-500 mb-3">File Risk Distribution</h3>
                <div className="space-y-2">
                  {[{label:'Critical',min:75},{label:'High',min:55},{label:'Medium',min:30},{label:'Low',min:0}].map(({label,min}) => {
                    const count = filesData.filter(f => f.risk_score >= min && (min===0 || f.risk_score < (min===30?55:min===55?75:200))).length;
                    const colors: Record<string,string> = { Critical:'text-red-600', High:'text-orange-500', Medium:'text-yellow-600', Low:'text-green-600' };
                    return <div key={label} className="flex justify-between text-sm"><span className={colors[label]}>{label}</span><span className="font-medium">{count} files</span></div>;
                  })}
                </div>
              </div>
              <div className="bg-white rounded-lg shadow p-5">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Top Flaky CI Runs</h3>
                {flakyData.slice(0, 4).map(f => (
                  <div key={f.ci_run_id} className="flex justify-between text-sm py-1">
                    <span className="text-gray-700 truncate max-w-[140px]">{f.run_name}</span>
                    <span className="text-orange-500 font-medium">{(f.flakiness_prob * 100).toFixed(0)}%</span>
                  </div>
                ))}
                {!flakyData.length && <p className="text-gray-400 text-sm">No flaky tests detected.</p>}
              </div>
              <div className="bg-white rounded-lg shadow p-5">
                <h3 className="text-sm font-medium text-gray-500 mb-3">DORA Snapshot</h3>
                {doraData ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span>Deploy Freq</span><span className={ratingColor(doraData.deployment_frequency.rating)}>{doraData.deployment_frequency.value}/day</span></div>
                    <div className="flex justify-between"><span>Lead Time</span><span className={ratingColor(doraData.lead_time_for_changes.rating)}>{doraData.lead_time_for_changes.value}h</span></div>
                    <div className="flex justify-between"><span>Change Failure</span><span className={ratingColor(doraData.change_failure_rate.rating)}>{doraData.change_failure_rate.value}%</span></div>
                  </div>
                ) : <p className="text-gray-400 text-sm">No release data yet.</p>}
              </div>
            </div>
          </div>
        )}

        {/* ── Files ────────────────────────────────────────────────────── */}
        {activeTab === 'files' && (
          <div className="bg-white shadow overflow-hidden rounded-lg">
            <div className="px-6 py-3 bg-gray-50 border-b text-xs text-gray-500">
              Click a row to see churn history, ownership, coupling rules, and violations.
            </div>
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>{['File','Language','Changes','Risk'].map(h => (
                  <th key={h} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filesData.map((f, i) => (
                  <tr key={i} className="hover:bg-blue-50 cursor-pointer" onClick={() => openFileDetail(f)}>
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 max-w-xs truncate">{f.path}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 capitalize">{f.language}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">{f.changes ?? '—'}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${riskBg(f.risk_score)}`}>{f.risk_score}/100</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filesData.length && <p className="text-center py-12 text-gray-400">No files yet — trigger a backfill.</p>}
          </div>
        )}

        {/* ── Pull Requests ─────────────────────────────────────────────── */}
        {activeTab === 'prs' && (
          <div className="space-y-4">
            <div className="bg-white shadow overflow-hidden rounded-lg">
              <div className="px-6 py-3 bg-gray-50 border-b text-xs text-gray-500">
                Click a row to see the full risk breakdown and AI explanation.
              </div>
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>{['#','Title','Author','State','Risk','Opened'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {prsData.map(pr => (
                    <tr key={pr.id} className="hover:bg-blue-50 cursor-pointer" onClick={() => openPRDetail(pr)}>
                      <td className="px-4 py-3 text-sm text-gray-500">#{pr.number}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 max-w-xs truncate">{pr.title}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">{pr.author_login}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          pr.state === 'OPEN' ? 'bg-green-100 text-green-800' :
                          pr.state === 'MERGED' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-600'
                        }`}>{pr.state}</span>
                      </td>
                      <td className="px-4 py-3">
                        {pr.predicted_risk_score != null
                          ? <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskBg(pr.predicted_risk_score)}`}>{pr.predicted_risk_score}/100</span>
                          : <span className="text-gray-400 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400">{pr.created_at ? new Date(pr.created_at).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!prsData.length && <p className="text-center py-12 text-gray-400">No pull requests found.</p>}
            </div>
          </div>
        )}

        {/* ── Coupling ──────────────────────────────────────────────────── */}
        {activeTab === 'coupling' && (
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">File Coupling Graph</h2>
              <p className="text-xs text-gray-400 mb-4">Files that change together frequently. Thicker lines = stronger coupling.</p>
              <CouplingGraph nodes={couplingNodes} links={couplingLinks} />
            </div>
            {couplingLinks.length > 0 && (
              <div className="bg-white rounded-lg shadow overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>{['Source File','Target File','Coupling Score'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {[...couplingLinks].sort((a, b) => b.value - a.value).slice(0, 20).map((l, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-sm text-gray-700 font-mono truncate max-w-xs">{l.source}</td>
                        <td className="px-4 py-2 text-sm text-gray-700 font-mono truncate max-w-xs">{l.target}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-gray-100 rounded-full h-1.5">
                              <div className="h-1.5 rounded-full bg-orange-400" style={{ width: `${Math.min(l.value * 100, 100)}%` }} />
                            </div>
                            <span className="text-xs text-gray-500">{(l.value * 100).toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Releases / DORA ───────────────────────────────────────────── */}
        {activeTab === 'releases' && (
          <div className="space-y-6">
            {doraData ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <DoraCard title="Deployment Frequency"  value={doraData.deployment_frequency.value}  unit="/day" rating={doraData.deployment_frequency.rating}  label={doraData.deployment_frequency.label} />
                  <DoraCard title="Lead Time for Changes" value={doraData.lead_time_for_changes.value} unit="hrs"  rating={doraData.lead_time_for_changes.rating} label={doraData.lead_time_for_changes.label} />
                  <DoraCard title="Change Failure Rate"   value={doraData.change_failure_rate.value}   unit="%"    rating={doraData.change_failure_rate.rating}   label={doraData.change_failure_rate.label} />
                  <DoraCard title="Mean Time to Restore"  value={doraData.time_to_restore.value}       unit="hrs"  rating={doraData.time_to_restore.rating}       label={doraData.time_to_restore.label} />
                </div>
                <div className="bg-white rounded-lg shadow p-6">
                  <h3 className="text-base font-semibold text-gray-900 mb-4">DORA Rating Guide</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div><p className="font-medium text-gray-700 mb-2">Deployment Frequency</p>
                      <p className="text-green-600">Elite: &ge;1/day</p><p className="text-blue-600">High: &ge;1/week</p>
                      <p className="text-yellow-600">Medium: &ge;1/month</p><p className="text-red-600">Low: &lt;1/month</p>
                    </div>
                    <div><p className="font-medium text-gray-700 mb-2">Lead Time for Changes</p>
                      <p className="text-green-600">Elite: &lt;1 hour</p><p className="text-blue-600">High: &lt;1 day</p>
                      <p className="text-yellow-600">Medium: &lt;1 week</p><p className="text-red-600">Low: &gt;1 week</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-lg shadow p-12 text-center text-gray-400">No release data. Run a backfill to compute DORA metrics.</div>
            )}
          </div>
        )}

        {/* ── CI / Tests ────────────────────────────────────────────────── */}
        {activeTab === 'ci' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-base font-semibold text-gray-900">Flaky CI Runs</h2>
                <p className="text-sm text-gray-500 mt-1">Ranked by TestPulse flakiness probability.</p>
              </div>
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>{['Run Name','SHA','Conclusion','Flakiness','Errors','Top Failure Pattern'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {flakyData.map(f => (
                    <tr key={f.ci_run_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{f.run_name}</td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-500">{f.head_sha?.slice(0, 7)}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${f.conclusion === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{f.conclusion}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-gray-100 rounded-full h-1.5"><div className="bg-orange-400 h-1.5 rounded-full" style={{ width: `${f.flakiness_prob * 100}%` }} /></div>
                          <span className="text-sm font-medium text-orange-600">{(f.flakiness_prob * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">{f.total_errors}</td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-400 max-w-xs truncate">{f.failure_signatures[0]?.template || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!flakyData.length && <p className="text-center py-12 text-gray-400">No CI analysis yet. Ensure the CI worker has run.</p>}
            </div>
          </div>
        )}

        {/* ── Team ──────────────────────────────────────────────────────── */}
        {activeTab === 'team' && (
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Developer Collaboration Graph</h2>
              <p className="text-xs text-gray-400 mb-4">Node size = commits. Blue intensity = betweenness centrality. Amber = knowledge silo.</p>
              <TeamGraph nodes={teamNodes} edges={teamEdges} />
            </div>
            {busFactor && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-lg shadow p-6">
                  <h3 className="text-base font-semibold text-gray-900 mb-3">Bus Factor</h3>
                  <div className="flex items-center gap-3 mb-4">
                    <span className={`text-3xl font-bold ${riskColor(busFactor.overall_bus_factor * 100)}`}>
                      {(busFactor.overall_bus_factor * 100).toFixed(0)}
                    </span>
                    <div>
                      <p className="text-xs text-gray-500">HHI score (0–100)</p>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskBg(busFactor.overall_bus_factor * 100)}`}>
                        {busFactor.risk_level.toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {busFactor.contributors.slice(0, 5).map(c => (
                      <div key={c.name} className="flex justify-between text-sm">
                        <span className="text-gray-700">{c.name}</span>
                        <span className="text-gray-500">{(c.share * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-white rounded-lg shadow p-6">
                  <h3 className="text-base font-semibold text-gray-900 mb-3">Recommendations</h3>
                  <ul className="space-y-2">
                    {busFactor.recommendations.map((r, i) => (
                      <li key={i} className="flex gap-2 text-sm text-gray-700"><span className="text-blue-500 mt-0.5">•</span>{r}</li>
                    ))}
                    {!busFactor.recommendations.length && <p className="text-gray-400 text-sm">No recommendations.</p>}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Settings ──────────────────────────────────────────────────── */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            {/* Risk Weights */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-2">Risk Score Weights</h2>
              <p className="text-sm text-gray-500 mb-6">Adjust how much each signal contributes to the unified risk score. Values are automatically normalised.</p>
              <div className="space-y-5">
                {Object.entries(repoConfig).map(([k, v]) => (
                  <div key={k}>
                    <div className="flex justify-between text-sm mb-1">
                      <label className="font-medium text-gray-700 capitalize">{k.replace(/_/g, ' ')}</label>
                      <span className="text-gray-500">{(v * 100).toFixed(0)}%</span>
                    </div>
                    <input type="range" min={0} max={100} value={Math.round(v * 100)}
                           onChange={e => setRepoConfig(prev => ({ ...prev, [k]: parseInt(e.target.value) / 100 }))}
                           className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-gray-200" />
                  </div>
                ))}
              </div>
              <div className="mt-6 flex gap-3">
                <button onClick={saveWeights} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">Save Weights</button>
                <button onClick={loadAll}     className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">Reset</button>
              </div>
            </div>

            {/* Architectural Policy Editor */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Architectural Policy</h2>
              <p className="text-sm text-gray-500 mb-4">Define layer boundary rules for ArchSentinel. JSON format.</p>
              <button onClick={generatePolicy} disabled={policyGenerating}
                      className="mb-3 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50">
                {policyGenerating ? 'Generating…' : 'Generate Policy from Repo'}
              </button>
              <textarea value={archPolicy} onChange={e => { setArchPolicy(e.target.value); setArchPolicyError(null); }}
                        placeholder={'{\n  "layers": { "domain": ["src/domain"], "infra": ["src/db"] },\n  "rules": [{ "from": "domain", "to": "infra", "allow": false }]\n}'}
                        rows={12}
                        className="w-full font-mono text-xs bg-gray-900 text-green-400 p-4 rounded-lg border border-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y" />
              {archPolicyError && <p className="text-red-500 text-xs mt-2">{archPolicyError}</p>}
              <button onClick={saveArchPolicy} disabled={archPolicySaving}
                      className="mt-3 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
                {archPolicySaving ? 'Saving…' : 'Save Policy'}
              </button>
            </div>

            {/* Notification Preferences */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Bot Notification Preferences</h2>
              <p className="text-sm text-gray-500 mb-4">Configure how the GitHub bot behaves when a PR exceeds the risk threshold.</p>
              <div className="space-y-5 mb-4">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <label className="font-medium text-gray-700">Block merge above score</label>
                    <span className="text-gray-500">{blockThreshold}/100</span>
                  </div>
                  <input type="range" min={30} max={100} value={blockThreshold}
                         onChange={e => setBlockThreshold(parseInt(e.target.value))}
                         className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-gray-200" />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700 block mb-2">Behavior above threshold</label>
                  <div className="flex gap-4">
                    {[{ val: false, label: 'Fail check run (blocks merge)' }, { val: true, label: 'Warn only (post comment)' }].map(opt => (
                      <label key={String(opt.val)} className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                        <input type="radio" checked={warnOnly === opt.val} onChange={() => setWarnOnly(opt.val)} />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <button onClick={saveNotificationPrefs} disabled={notifSaving}
                      className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
                {notifSaving ? 'Saving…' : 'Save Preferences'}
              </button>
            </div>

            {/* LLM Provider */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">LLM Provider</h2>
              <p className="text-sm text-gray-500 mb-4">Choose which AI model powers explanations and policy generation.</p>
              <div className="flex gap-6 mb-4">
                {(['gemini', 'openai', 'ollama'] as const).map(p => (
                  <label key={p} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="radio" checked={llmProvider === p} onChange={() => setLlmProvider(p)} />
                    {p === 'gemini' ? 'Google Gemini (default)' : p === 'openai' ? 'OpenAI GPT-4o' : 'Ollama (local)'}
                  </label>
                ))}
              </div>
              {llmProvider !== 'ollama' && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                  <input type="password" value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)}
                         placeholder="sk-… or AIzaSy…"
                         className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
              )}
              <button onClick={saveNotificationPrefs} disabled={notifSaving}
                      className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
                {notifSaving ? 'Saving…' : 'Save LLM Config'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── PR Detail Drawer ───────────────────────────────────────────────── */}
      {selectedPR && (
        <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-2xl border-l border-gray-200 flex flex-col z-40 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b bg-white flex-shrink-0">
            <div>
              <h3 className="text-base font-semibold text-gray-900">
                PR #{selectedPR.number} — {selectedPR.title.length > 40 ? selectedPR.title.slice(0, 38) + '…' : selectedPR.title}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-gray-500">by {selectedPR.author_login}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  selectedPR.state === 'OPEN' ? 'bg-green-100 text-green-800' :
                  selectedPR.state === 'MERGED' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-600'
                }`}>{selectedPR.state}</span>
                {selectedPR.predicted_risk_score != null && (
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskBg(selectedPR.predicted_risk_score)}`}>
                    Risk {selectedPR.predicted_risk_score}/100
                  </span>
                )}
              </div>
            </div>
            <button onClick={() => setSelectedPR(null)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none ml-4">×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {riskData && (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Risk Signal Breakdown</h4>
                <div className="space-y-3">{Object.entries(riskData.breakdown).map(([k, v]) => <RiskBar key={k} label={k} value={v} />)}</div>
              </div>
            )}
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">AI Root-Cause Explanation</h4>
              {prExplainLoading ? (
                <p className="text-sm text-gray-400 animate-pulse">Generating explanation…</p>
              ) : prExplainData ? (
                <div className="space-y-3">
                  <p className="text-sm text-gray-700 bg-blue-50 rounded-lg p-3">{prExplainData.summary}</p>
                  {prExplainData.root_causes?.length && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Root Causes</p>
                      <ul className="space-y-1">{prExplainData.root_causes.map((c, i) => (
                        <li key={i} className="text-sm text-gray-700 flex gap-2"><span className="text-red-400 mt-0.5 flex-shrink-0">•</span>{c}</li>
                      ))}</ul>
                    </div>
                  )}
                  {prExplainData.actions?.length && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Recommended Actions</p>
                      <ul className="space-y-1">{prExplainData.actions.map((a, i) => (
                        <li key={i} className="text-sm text-gray-700 flex gap-2">
                          <span className="text-blue-400 mt-0.5 flex-shrink-0">→</span>
                          <span>{a.description}{a.file && <span className="font-mono text-xs text-gray-400 ml-1">({a.file})</span>}</span>
                        </li>
                      ))}</ul>
                    </div>
                  )}
                </div>
              ) : <p className="text-xs text-gray-400">No explanation available.</p>}
            </div>
            {prDetailLoading ? (
              <p className="text-sm text-gray-400 animate-pulse">Loading PR details…</p>
            ) : prDetail?.comments?.length ? (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2">Review Comments ({prDetail.comments.length})</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {prDetail.comments.slice(0, 5).map((c) => (
                    <div key={c.id} className="bg-gray-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-gray-600 mb-1">{c.author_login}</p>
                      <p className="text-xs text-gray-700 line-clamp-3">{c.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* ── File Detail Drawer ─────────────────────────────────────────────── */}
      {selectedFile && (
        <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-2xl border-l border-gray-200 flex flex-col z-40 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b bg-white flex-shrink-0">
            <div>
              <h3 className="text-base font-semibold text-gray-900 font-mono truncate max-w-[380px]">{selectedFile.path}</h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-gray-500 capitalize">{selectedFile.language}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskBg(selectedFile.risk_score)}`}>Risk {selectedFile.risk_score}/100</span>
              </div>
            </div>
            <button onClick={() => setSelectedFile(null)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none ml-4">×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {fileDetailLoading ? (
              <p className="text-sm text-gray-400 animate-pulse text-center py-8">Loading file details…</p>
            ) : fileDetail ? (
              <>
                {fileDetail.churn_history.length > 0 && (() => {
                  const W = 400, H = 60, pad = 6;
                  const data = fileDetail.churn_history;
                  const maxChurn = Math.max(...data.map(d => d.additions + d.deletions), 1);
                  const pts = data.map((d, i) => {
                    const x = pad + (i / Math.max(data.length - 1, 1)) * (W - pad * 2);
                    const y = H - pad - ((d.additions / maxChurn) * (H - pad * 2));
                    return `${x},${y}`;
                  }).join(' ');
                  return (
                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 mb-2">Churn History (90 days)</h4>
                      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-gray-50">
                        <polyline points={pts} fill="none" stroke="#22c55e" strokeWidth="2" strokeLinejoin="round" />
                      </svg>
                      <p className="text-xs text-gray-400 mt-1">Green = weekly additions</p>
                    </div>
                  );
                })()}
                {fileDetail.ownership.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Ownership Distribution</h4>
                    <OwnershipPie ownership={fileDetail.ownership} />
                  </div>
                )}
                {fileDetail.coupling_rules.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Files That Change Together ({fileDetail.coupling_rules.length})</h4>
                    <div className="space-y-1">
                      {fileDetail.coupling_rules.slice(0, 8).map((r, i) => (
                        <div key={i} className="flex justify-between items-center text-sm bg-gray-50 rounded px-3 py-1.5">
                          <span className="font-mono text-xs text-gray-700 truncate max-w-[320px]">{r.file}</span>
                          <span className="text-xs text-orange-600 font-medium ml-2">{(r.score * 100).toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {fileDetail.violations.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Architectural Violations ({fileDetail.violations.length})</h4>
                    <div className="space-y-2">
                      {fileDetail.violations.map((v, i) => (
                        <div key={i} className="bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                          <div className="flex justify-between items-start">
                            <span className="text-xs font-semibold text-red-700">{v.type}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${v.severity === 'critical' ? 'bg-red-200 text-red-800' : 'bg-orange-100 text-orange-700'}`}>{v.severity}</span>
                          </div>
                          <p className="text-xs text-gray-600 mt-1">{v.description}</p>
                          {v.line > 0 && <p className="text-xs text-gray-400 mt-0.5">Line {v.line}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!fileDetail.churn_history.length && !fileDetail.ownership.length && !fileDetail.coupling_rules.length && !fileDetail.violations.length && (
                  <p className="text-gray-400 text-sm text-center py-8">No detailed data yet. Trigger a full backfill.</p>
                )}
              </>
            ) : (
              <p className="text-gray-400 text-sm text-center py-8">Could not load file details.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Chat Sidebar ──────────────────────────────────────────────────── */}
      {chatOpen && (
        <div className="fixed right-0 top-0 h-full w-96 bg-white shadow-2xl border-l border-gray-200 flex flex-col z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-blue-600">
            <h3 className="text-white font-semibold">AI Assistant</h3>
            <button onClick={() => setChatOpen(false)} className="text-blue-200 hover:text-white text-xl">×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {!chatHistory.length && (
              <div className="text-center text-gray-400 mt-8 text-sm">
                <p className="mb-2">Ask me anything about this repository:</p>
                {["What are the riskiest files?", "Which tests are flaky?", "Who should review PRs in the auth module?"].map(q => (
                  <button key={q} onClick={() => setChatInput(q)}
                          className="block mx-auto mb-2 text-left text-blue-600 hover:underline text-xs">"{q}"</button>
                ))}
              </div>
            )}
            {chatHistory.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${m.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-gray-100 text-gray-800 rounded-bl-none'}`}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 px-3 py-2 rounded-lg text-sm text-gray-500 animate-pulse">Thinking…</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="p-3 border-t border-gray-200 flex gap-2">
            <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                   placeholder="Ask about this repo…"
                   className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            <button onClick={sendChat} disabled={!chatInput.trim() || chatLoading}
                    className="px-3 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">Send</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
