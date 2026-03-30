import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { API_BASE_URL, WS_BASE_URL } from '../lib/apiConfig';

// ── Types ─────────────────────────────────────────────────────────────────

interface RepoData { id: string; name: string; owner: string; synced_at: string; stats?: { commits: number; pull_requests: number } }
interface FileData { path: string; language: string; lines: number; risk_score: number; changes?: number; violations: string[] }
interface PRData { id: string; number: number; title: string; state: string; author_login: string; created_at: string; merged_at?: string; predicted_risk_score?: number; repo_id: string }
interface RiskData { score: number; label: string; breakdown: Record<string, number>; weights?: Record<string, number> }
interface DoraData { deployment_frequency: { value: number; rating: string; label: string }; lead_time_for_changes: { value: number; rating: string; label: string }; change_failure_rate: { value: number; rating: string; label: string }; time_to_restore: { value: number | null; rating: string; label: string } }
interface FlakyTest { ci_run_id: string; run_name: string; head_sha: string; conclusion: string; flakiness_prob: number; total_errors: number; failure_signatures: { template: string; count: number }[]; created_at: string }
interface TeamNode { id: string; commit_count: number }
interface TeamEdge { source: string; target: string; weight: number }
interface BusFactor { overall_bus_factor: number; risk_level: string; contributors: { name: string; share: number; weighted_commits: number }[]; recommendations: string[] }
interface ChatMessage { role: 'user' | 'assistant'; content: string }
interface CouplingNode { id: string; group: number }
interface CouplingLink { source: string; target: string; value: number }

type Tab = 'overview' | 'files' | 'prs' | 'coupling' | 'releases' | 'ci' | 'team' | 'settings';

// ── Helpers ───────────────────────────────────────────────────────────────

const riskColor  = (s: number) => s >= 75 ? 'text-red-400'    : s >= 55 ? 'text-orange-400' : s >= 30 ? 'text-yellow-400' : 'text-green-400';
const riskBg     = (s: number) => s >= 75 ? 'bg-red-950 text-red-400'    : s >= 55 ? 'bg-orange-950 text-orange-400' : s >= 30 ? 'bg-yellow-950 text-yellow-400' : 'bg-green-950 text-green-400';
const ratingColor = (r: string) => ({ elite: 'text-green-400', high: 'text-lime-400', medium: 'text-yellow-400', low: 'text-red-400', unknown: 'text-neutral-500' }[r] ?? 'text-neutral-500');
const ratingBg    = (r: string) => ({ elite: 'bg-green-950 text-green-400', high: 'bg-lime-950 text-lime-400', medium: 'bg-yellow-950 text-yellow-400', low: 'bg-red-950 text-red-400', unknown: 'bg-neutral-900 text-neutral-500' }[r] ?? 'bg-neutral-900 text-neutral-500');

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` });

async function apiFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
};

// ── Sub-components ────────────────────────────────────────────────────────

const StatCard: React.FC<{ label: string; value: string | number; sub?: string }> = ({ label, value, sub }) => (
  <div className="rounded-lg p-5 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)', boxShadow: 'var(--shadow)' }}>
    <p className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{label}</p>
    <p className="text-2xl font-bold mt-2" style={{ color: 'var(--text-h)', fontFamily: 'var(--heading)' }}>{value}</p>
    {sub && <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
  </div>
);

const RiskBar: React.FC<{ label: string; value: number; max?: number }> = ({ label, value, max = 100 }) => (
  <div>
    <div className="flex justify-between mb-1">
      <span className="capitalize" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{label.replace(/_/g, ' ')}</span>
      <span className={`font-medium ${riskColor(value)}`} style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{value}/{max}</span>
    </div>
    <div className="w-full rounded-full h-1.5" style={{ background: 'var(--border)' }}>
      <div className={`h-1.5 rounded-full ${value >= 75 ? 'bg-red-400' : value >= 55 ? 'bg-orange-400' : value >= 30 ? 'bg-yellow-400' : 'bg-green-400'}`}
           style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  </div>
);

const DoraCard: React.FC<{ title: string; value: number | null; unit: string; rating: string; label: string }> = ({ title, value, unit, rating, label }) => (
  <div className="rounded-lg p-5 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)', boxShadow: 'var(--shadow)' }}>
    <p className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{title}</p>
    <p className="text-2xl font-bold mt-2" style={{ color: 'var(--text-h)', fontFamily: 'var(--heading)' }}>
      {value !== null && value !== undefined ? `${value} ${unit}` : '—'}
    </p>
    <span className={`inline-block mt-2 px-2 py-0.5 rounded text-xs font-medium ${ratingBg(rating)}`} style={{ fontFamily: 'var(--mono)' }}>
      {rating.toUpperCase()}
    </span>
    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
  </div>
);

// ── Team Graph (circle layout, pure SVG) ──────────────────────────────────

const TeamGraph: React.FC<{ nodes: TeamNode[]; edges: TeamEdge[] }> = ({ nodes, edges }) => {
  if (!nodes.length) return <p className="text-center py-8" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>No developer data yet.</p>;

  const W = 600, H = 400, cx = W / 2, cy = H / 2, R = 160;
  const positions: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    positions[n.id] = { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
  });

  const maxCommits = Math.max(...nodes.map(n => n.commit_count), 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl mx-auto">
      {edges.map((e, i) => {
        const s = positions[e.source], t = positions[e.target];
        if (!s || !t) return null;
        return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                     stroke="#4ade80" strokeWidth={Math.min(e.weight, 4)} strokeOpacity={0.5} />;
      })}
      {nodes.map(n => {
        const p = positions[n.id];
        const r = 8 + (n.commit_count / maxCommits) * 14;
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={r} fill="#84cc16" fillOpacity={0.85} />
            <text x={p.x} y={p.y + r + 12} textAnchor="middle" fontSize={11} fill="#e2ddd5">
              {n.id.length > 12 ? n.id.slice(0, 10) + '…' : n.id}
            </text>
            <text x={p.x} y={p.y + r + 22} textAnchor="middle" fontSize={9} fill="#7a7d6f">
              {n.commit_count} commits
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ── Coupling Graph (circle layout, pure SVG) ──────────────────────────────

const CouplingGraph: React.FC<{ nodes: CouplingNode[]; links: CouplingLink[] }> = ({ nodes, links }) => {
  if (!nodes.length) return <p className="text-center py-8" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>No coupling data yet. Sync a repo with commit history.</p>;

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
        return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                     stroke="#84cc16" strokeWidth={Math.max(1, l.value * 6)} strokeOpacity={0.4} />;
      })}
      {nodes.map(n => {
        const p = positions[n.id];
        if (!p) return null;
        const short = n.id.includes('/') ? n.id.split('/').pop()! : n.id;
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={8} fill="#84cc16" fillOpacity={0.85} />
            <text x={p.x} y={p.y + 20} textAnchor="middle" fontSize={10} fill="#e2ddd5">
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
  const [repoData,   setRepoData]   = useState<RepoData | null>(null);
  const [filesData,  setFilesData]  = useState<FileData[]>([]);
  const [prsData,    setPrsData]    = useState<PRData[]>([]);
  const [riskData,   setRiskData]   = useState<RiskData | null>(null);
  const [doraData,   setDoraData]   = useState<DoraData | null>(null);
  const [flakyData,  setFlakyData]  = useState<FlakyTest[]>([]);
  const [teamNodes,  setTeamNodes]  = useState<TeamNode[]>([]);
  const [teamEdges,  setTeamEdges]  = useState<TeamEdge[]>([]);
  const [busFactor,  setBusFactor]  = useState<BusFactor | null>(null);
  const [couplingNodes, setCouplingNodes] = useState<CouplingNode[]>([]);
  const [couplingLinks, setCouplingLinks] = useState<CouplingLink[]>([]);
  const [prExplanation,  setPrExplanation]  = useState<{ prId: string; text: string } | null>(null);
  const [explainLoading, setExplainLoading] = useState<string | null>(null);
  const [repoConfig, setRepoConfig] = useState<Record<string, number>>({ coupling: 0.25, architecture: 0.20, bus_factor: 0.20, collaboration: 0.15, ci: 0.20 });

  const [loading,   setLoading]   = useState(true);
  const [progress,  setProgress]  = useState<{ status: string; details?: string }>({ status: 'Connecting…' });
  const [triggeringBackfill, setTriggeringBackfill] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  // Chat
  const [chatOpen,        setChatOpen]        = useState(false);
  const [chatInput,       setChatInput]       = useState('');
  const [chatHistory,     setChatHistory]     = useState<ChatMessage[]>([]);
  const [chatLoading,     setChatLoading]     = useState(false);
  const [chatRawHistory,  setChatRawHistory]  = useState<Record<string, any>[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (chatOpen) {
      chatInputRef.current?.focus();
    }
  }, [chatOpen]);

  const location = useLocation();
  const navigate = useNavigate();
  const incomingRepoId = location.state?.repoId as string | undefined;
  const storedRepoId = typeof window !== 'undefined' ? localStorage.getItem('selectedRepoId') : null;
  const [repoId, setRepoId] = useState<string | null>(incomingRepoId ?? storedRepoId);

  useEffect(() => {
    if (incomingRepoId && incomingRepoId !== repoId) {
      setRepoId(incomingRepoId);
    }
  }, [incomingRepoId, repoId]);

  useEffect(() => {
    if (repoId) {
      localStorage.setItem('selectedRepoId', repoId);
    } else if (typeof window !== 'undefined') {
      localStorage.removeItem('selectedRepoId');
    }
  }, [repoId]);

  // Live WS for PR score updates
  useEffect(() => {
    if (!repoId) return;
    const ws = new WebSocket(`${WS_BASE_URL}/ws/repos/${repoId}/live`);
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'pr_scored') {
        setPrsData(prev => prev.map(pr =>
          pr.id === data.pr_id ? { ...pr, predicted_risk_score: data.score } : pr
        ));
      }
    };
    return () => ws.close();
  }, [repoId]);

  // Backfill progress WS
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
      const [repo, files, prs, risk, dora, flaky, team, bf, coupling] = await Promise.all([
        apiFetch<RepoData>(`${API_BASE_URL}/repos/${repoId}`),
        apiFetch<FileData[]>(`${API_BASE_URL}/repos/${repoId}/files`),
        apiFetch<PRData[]>(`${API_BASE_URL}/prs/?repo_id=${repoId}&limit=50`),
        apiFetch<RiskData>(`${API_BASE_URL}/repos/${repoId}/risk`),
        apiFetch<DoraData>(`${API_BASE_URL}/repos/${repoId}/releases`),
        apiFetch<FlakyTest[]>(`${API_BASE_URL}/repos/${repoId}/tests/flaky`),
        apiFetch<{ nodes: TeamNode[]; edges: TeamEdge[] }>(`${API_BASE_URL}/repos/${repoId}/team/graph`),
        apiFetch<BusFactor>(`${API_BASE_URL}/repos/${repoId}/team/bus-factor`),
        apiFetch<{ nodes: CouplingNode[]; links: CouplingLink[] }>(`${API_BASE_URL}/repos/${repoId}/coupling`),
      ]);
      if (repo)     setRepoData(repo);
      if (files)    setFilesData(files);
      if (prs)      setPrsData(prs);
      if (risk)     { setRiskData(risk); setRepoConfig(risk.weights ?? repoConfig); }
      if (dora)     setDoraData(dora);
      if (flaky)    setFlakyData(flaky);
      if (team)     { setTeamNodes(team.nodes); setTeamEdges(team.edges); }
      if (bf)       setBusFactor(bf);
      if (coupling) { setCouplingNodes(coupling.nodes); setCouplingLinks(coupling.links); }
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  const triggerBackfill = async () => {
    if (!repoId) return;
    setTriggeringBackfill(true);
    setBackfillMsg(null);
    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/backfill`, { method: 'POST', headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json())?.detail || 'Failed');
      setBackfillMsg('Backfill queued.');
    } catch (e: any) {
      setBackfillMsg(e.message || 'Error');
    } finally {
      setTriggeringBackfill(false);
    }
  };

  const saveWeights = async () => {
    if (!repoId) return;
    const total = Object.values(repoConfig).reduce((a, b) => a + b, 0);
    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(repoConfig)) normalized[k] = v / total;
    await fetch(`${API_BASE_URL}/repos/${repoId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { weights_normalized: normalized } }),
    });
  };

  const sendChat = async (message?: string) => {
    if (chatLoading) return;
    const raw = message ?? chatInput;
    const trimmed = raw.trim();
    if (!trimmed || !repoId) return;
    const userMsg: ChatMessage = { role: 'user', content: trimmed };
    setChatHistory(prev => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);
    chatInputRef.current?.focus();

    const historyPayload = chatRawHistory.slice(-10);
    const appendAssistantToRawHistory = (assistantEntry: ChatMessage) => {
      const next = [...historyPayload, userMsg, assistantEntry];
      setChatRawHistory(next.slice(-50));
      return assistantEntry;
    };

    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/chat`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: historyPayload,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        const assistantContent = data.response || 'No response.';
        const assistantEntry: ChatMessage = { role: 'assistant', content: assistantContent };
        setChatHistory(prev => [...prev, assistantEntry]);
        if (Array.isArray(data.history)) {
          setChatRawHistory(data.history.slice(-50));
        } else {
          appendAssistantToRawHistory(assistantEntry);
        }
      } else {
        const assistantEntry = appendAssistantToRawHistory({
          role: 'assistant',
          content: 'Error: Could not get a response.',
        });
        setChatHistory(prev => [...prev, assistantEntry]);
      }
    } catch {
      const assistantEntry = appendAssistantToRawHistory({
        role: 'assistant',
        content: 'Network error.',
      });
      setChatHistory(prev => [...prev, assistantEntry]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  };

  const handleQuickQuestion = (question: string) => {
    setChatOpen(true);
    setChatInput(question);
    chatInputRef.current?.focus();
    sendChat(question);
  };

  const explainPR = async (prId: string) => {
    setExplainLoading(prId);
    setPrExplanation(null);
    try {
      const r = await fetch(`${API_BASE_URL}/prs/${prId}/explain`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (r.ok) {
        const data = await r.json();
        const text = typeof data === 'string' ? data : (data.summary ?? data.explanation ?? JSON.stringify(data, null, 2));
        setPrExplanation({ prId, text });
      }
    } finally {
      setExplainLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 mx-auto" style={{ borderWidth: '2px', borderStyle: 'solid', borderColor: 'var(--border)', borderBottomColor: 'var(--accent)' }} />
          <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Loading dashboard…</p>
        </div>
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview',  label: 'Overview' },
    { key: 'files',     label: 'Files' },
    { key: 'prs',       label: 'Pull Requests' },
    { key: 'coupling',  label: 'Coupling' },
    { key: 'releases',  label: 'Releases' },
    { key: 'ci',        label: 'CI / Tests' },
    { key: 'team',      label: 'Team' },
    { key: 'settings',  label: 'Settings' },
  ];

  return (
    <div className="min-h-screen relative" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header className="border-b sticky top-0 z-40" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)', letterSpacing: '-0.03em' }}>RepoLens</h1>
              {repoData && <p style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{repoData.owner}/{repoData.name}</p>}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setChatOpen(o => !o)}
                      className="px-4 py-2 text-sm font-semibold rounded-md transition-opacity hover:opacity-85"
                      style={{ background: 'var(--accent)', color: '#0d1209' }}>
                {chatOpen ? 'Close Chat' : 'AI Assistant'}
              </button>
              <button onClick={() => navigate('/setup')}
                      className="px-4 py-2 text-sm rounded-md transition-colors"
                      style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}>
                Switch Repo
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Tabs */}
        <div className="border-b mb-6" style={{ borderColor: 'var(--border)' }}>
          <nav className="-mb-px flex space-x-1 overflow-x-auto">
            {tabs.map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                      className="py-2.5 px-3 border-b-2 text-sm whitespace-nowrap transition-colors"
                      style={activeTab === t.key
                        ? { borderBottomColor: 'var(--accent)', color: 'var(--accent)', fontFamily: 'var(--mono)', fontWeight: 500 }
                        : { borderBottomColor: 'transparent', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
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

            {/* Risk Score */}
            {riskData && (
              <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)', boxShadow: 'var(--shadow)' }}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>Unified Risk Score</h2>
                  <span className={`text-3xl font-bold ${riskColor(riskData.score)}`} style={{ fontFamily: 'var(--heading)' }}>{riskData.score}/100</span>
                </div>
                <span className={`inline-block mb-4 px-3 py-1 rounded text-xs font-medium ${riskBg(riskData.score)}`} style={{ fontFamily: 'var(--mono)' }}>
                  {riskData.label.toUpperCase()}
                </span>
                <div className="space-y-3">
                  {Object.entries(riskData.breakdown).map(([k, v]) => <RiskBar key={k} label={k} value={v} />)}
                </div>
              </div>
            )}

            {/* Backfill progress (only when pending) */}
            {repoId && progress.status !== 'complete' && (
              <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                <h3 className="text-sm font-medium mb-3" style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sync Status</h3>
                <p className="text-sm mb-1" style={{ color: 'var(--text)' }}>{progress.status}</p>
                {progress.details && <p className="text-xs mb-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{progress.details}</p>}
                <button onClick={triggerBackfill} disabled={triggeringBackfill}
                        className="px-3 py-1.5 text-sm font-semibold rounded-md disabled:opacity-50 transition-opacity hover:opacity-85"
                        style={{ background: 'var(--accent)', color: '#0d1209', border: 'none', cursor: 'pointer' }}>
                  {triggeringBackfill ? 'Triggering…' : 'Trigger Backfill'}
                </button>
                {backfillMsg && <p className="text-xs mt-2" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{backfillMsg}</p>}
              </div>
            )}

            {/* Summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-lg p-5 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>File Risk Distribution</h3>
                <div className="space-y-2">
                  {[{label:'Critical',min:75},{label:'High',min:55},{label:'Medium',min:30},{label:'Low',min:0}].map(({label,min}) => {
                    const count = filesData.filter(f => f.risk_score >= min && (min===0 || f.risk_score < (min===30?55:min===55?75:200))).length;
                    const colors = { Critical:'text-red-400', High:'text-orange-400', Medium:'text-yellow-400', Low:'text-green-400' } as any;
                    return <div key={label} className="flex justify-between" style={{ fontSize: '0.85rem' }}><span className={colors[label]}>{label}</span><span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{count} files</span></div>;
                  })}
                </div>
              </div>
              <div className="rounded-lg p-5 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Top Flaky CI Runs</h3>
                {flakyData.slice(0, 4).map(f => (
                  <div key={f.ci_run_id} className="flex justify-between py-1" style={{ fontSize: '0.85rem' }}>
                    <span className="truncate max-w-[140px]" style={{ color: 'var(--text)' }}>{f.run_name}</span>
                    <span className="font-medium text-orange-400" style={{ fontFamily: 'var(--mono)' }}>{(f.flakiness_prob * 100).toFixed(0)}%</span>
                  </div>
                ))}
                {!flakyData.length && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontFamily: 'var(--mono)' }}>No flaky tests detected.</p>}
              </div>
              <div className="rounded-lg p-5 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>DORA Snapshot</h3>
                {doraData ? (
                  <div className="space-y-2" style={{ fontSize: '0.85rem' }}>
                    <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Deploy Freq</span><span className={ratingColor(doraData.deployment_frequency.rating)} style={{ fontFamily: 'var(--mono)' }}>{doraData.deployment_frequency.value}/day</span></div>
                    <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Lead Time</span><span className={ratingColor(doraData.lead_time_for_changes.rating)} style={{ fontFamily: 'var(--mono)' }}>{doraData.lead_time_for_changes.value}h</span></div>
                    <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Change Failure</span><span className={ratingColor(doraData.change_failure_rate.rating)} style={{ fontFamily: 'var(--mono)' }}>{doraData.change_failure_rate.value}%</span></div>
                  </div>
                ) : <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontFamily: 'var(--mono)' }}>No release data yet.</p>}
              </div>
            </div>
          </div>
        )}

        {/* ── Files ────────────────────────────────────────────────────── */}
        {activeTab === 'files' && (
          <div className="overflow-hidden rounded-lg border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
            <table className="min-w-full">
              <thead style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                <tr>
                  {['File','Language','Changes','Risk'].map(h => (
                    <th key={h} className="px-6 py-3 text-left" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filesData.map((f, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }} className="transition-colors hover:bg-[#1a2115]">
                    <td className="px-6 py-3.5 max-w-xs truncate" style={{ color: 'var(--text-h)', fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>{f.path}</td>
                    <td className="px-6 py-3.5 capitalize" style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{f.language}</td>
                    <td className="px-6 py-3.5" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>{f.changes ?? '—'}</td>
                    <td className="px-6 py-3.5">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${riskBg(f.risk_score)}`} style={{ fontFamily: 'var(--mono)' }}>
                        {f.risk_score}/100
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filesData.length && <p className="text-center py-12" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>No files yet — trigger a backfill.</p>}
          </div>
        )}

        {/* ── Pull Requests ─────────────────────────────────────────────── */}
        {activeTab === 'prs' && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
              <table className="min-w-full">
                <thead style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                  <tr>
                    {['#','Title','Author','State','Risk','Opened',''].map(h => (
                      <th key={h} className="px-4 py-3 text-left" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {prsData.map(pr => (
                    <React.Fragment key={pr.id}>
                      <tr style={{ borderBottom: '1px solid var(--border)' }} className="transition-colors hover:bg-[#1a2115]">
                        <td className="px-4 py-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>#{pr.number}</td>
                        <td className="px-4 py-3 max-w-xs truncate" style={{ color: 'var(--text-h)', fontSize: '0.88rem' }}>{pr.title}</td>
                        <td className="px-4 py-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>{pr.author_login}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium`} style={{
                            fontFamily: 'var(--mono)',
                            ...(pr.state === 'OPEN'
                              ? { background: 'rgba(74,222,128,0.1)', color: '#4ade80' }
                              : pr.state === 'MERGED'
                              ? { background: 'rgba(132,204,22,0.1)', color: '#84cc16' }
                              : { background: 'var(--surface)', color: 'var(--text-muted)' })
                          }}>{pr.state}</span>
                        </td>
                        <td className="px-4 py-3">
                          {pr.predicted_risk_score != null ? (
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${riskBg(pr.predicted_risk_score)}`} style={{ fontFamily: 'var(--mono)' }}>
                              {pr.predicted_risk_score}/100
                            </span>
                          ) : <span style={{ color: 'var(--text-muted)', fontSize: '0.83rem', fontFamily: 'var(--mono)' }}>—</span>}
                        </td>
                        <td className="px-4 py-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>
                          {pr.created_at ? new Date(pr.created_at).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => prExplanation?.prId === pr.id ? setPrExplanation(null) : explainPR(pr.id)}
                            disabled={explainLoading === pr.id}
                            className="px-2 py-1 text-xs rounded disabled:opacity-50 transition-colors"
                            style={{ color: 'var(--accent)', border: '1px solid var(--accent-border)', background: 'transparent', fontFamily: 'var(--mono)', cursor: 'pointer' }}
                          >
                            {explainLoading === pr.id ? '…' : prExplanation?.prId === pr.id ? 'Hide' : 'Explain'}
                          </button>
                        </td>
                      </tr>
                      {prExplanation?.prId === pr.id && (
                        <tr>
                          <td colSpan={7} className="px-4 py-3" style={{ background: 'var(--accent-bg)', borderTop: '1px solid var(--accent-border)' }}>
                            <p className="text-xs font-semibold mb-1" style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>Risk Explanation</p>
                            <pre className="text-xs whitespace-pre-wrap" style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{prExplanation.text}</pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
              {!prsData.length && <p className="text-center py-12" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>No pull requests found.</p>}
            </div>
          </div>
        )}

        {/* ── Coupling ──────────────────────────────────────────────────── */}
        {activeTab === 'coupling' && (
          <div className="space-y-6">
            <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
              <h2 className="text-base font-semibold mb-1" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>File Coupling Graph</h2>
              <p className="text-xs mb-4" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Files that change together frequently. Thicker lines = stronger coupling.</p>
              <CouplingGraph nodes={couplingNodes} links={couplingLinks} />
            </div>
            {couplingLinks.length > 0 && (
              <div className="overflow-hidden rounded-lg border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                <table className="min-w-full">
                  <thead style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                    <tr>
                      {['Source File', 'Target File', 'Coupling Score'].map(h => (
                        <th key={h} className="px-4 py-3 text-left" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...couplingLinks].sort((a, b) => b.value - a.value).slice(0, 20).map((l, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }} className="transition-colors hover:bg-[#1a2115]">
                        <td className="px-4 py-2 truncate max-w-xs" style={{ color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>{l.source}</td>
                        <td className="px-4 py-2 truncate max-w-xs" style={{ color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>{l.target}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <div className="w-24 rounded-full h-1.5" style={{ background: 'var(--border)' }}>
                              <div className="h-1.5 rounded-full" style={{ width: `${Math.min(l.value * 100, 100)}%`, background: 'var(--accent)' }} />
                            </div>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontFamily: 'var(--mono)' }}>{(l.value * 100).toFixed(0)}%</span>
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
                  <DoraCard title="Deployment Frequency" value={doraData.deployment_frequency.value} unit="/day" rating={doraData.deployment_frequency.rating} label={doraData.deployment_frequency.label} />
                  <DoraCard title="Lead Time for Changes" value={doraData.lead_time_for_changes.value} unit="hrs" rating={doraData.lead_time_for_changes.rating} label={doraData.lead_time_for_changes.label} />
                  <DoraCard title="Change Failure Rate" value={doraData.change_failure_rate.value} unit="%" rating={doraData.change_failure_rate.rating} label={doraData.change_failure_rate.label} />
                  <DoraCard title="Mean Time to Restore" value={doraData.time_to_restore.value} unit="hrs" rating={doraData.time_to_restore.rating} label={doraData.time_to_restore.label} />
                </div>
                <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                  <h3 className="text-base font-semibold mb-4" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>DORA Rating Guide</h3>
                  <div className="grid grid-cols-2 gap-4" style={{ fontSize: '0.85rem', fontFamily: 'var(--mono)' }}>
                    <div><p className="font-medium mb-2" style={{ color: 'var(--text)' }}>Deployment Frequency</p>
                      <p className="text-green-400">Elite: ≥1/day</p>
                      <p className="text-lime-400">High: ≥1/week</p>
                      <p className="text-yellow-400">Medium: ≥1/month</p>
                      <p className="text-red-400">Low: &lt;1/month</p>
                    </div>
                    <div><p className="font-medium mb-2" style={{ color: 'var(--text)' }}>Lead Time for Changes</p>
                      <p className="text-green-400">Elite: &lt;1 hour</p>
                      <p className="text-lime-400">High: &lt;1 day</p>
                      <p className="text-yellow-400">Medium: &lt;1 week</p>
                      <p className="text-red-400">Low: &gt;1 week</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-lg p-12 text-center border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)', color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>
                No release data. Run a backfill to compute DORA metrics.
              </div>
            )}
          </div>
        )}

        {/* ── CI / Tests ────────────────────────────────────────────────── */}
        {activeTab === 'ci' && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
              <div className="px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
                <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>Flaky CI Runs</h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>Ranked by TestPulse flakiness probability.</p>
              </div>
              <table className="min-w-full">
                <thead style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                  <tr>
                    {['Run Name','SHA','Conclusion','Flakiness','Errors','Top Failure Pattern'].map(h => (
                      <th key={h} className="px-4 py-3 text-left" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {flakyData.map(f => (
                    <tr key={f.ci_run_id} style={{ borderBottom: '1px solid var(--border)' }} className="transition-colors hover:bg-[#1a2115]">
                      <td className="px-4 py-3" style={{ color: 'var(--text-h)', fontSize: '0.88rem' }}>{f.run_name}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{f.head_sha?.slice(0, 7)}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-xs font-medium" style={{
                          fontFamily: 'var(--mono)',
                          ...(f.conclusion === 'success'
                            ? { background: 'rgba(74,222,128,0.1)', color: '#4ade80' }
                            : { background: 'rgba(248,113,113,0.1)', color: '#f87171' })
                        }}>{f.conclusion}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 rounded-full h-1.5" style={{ background: 'var(--border)' }}>
                            <div className="h-1.5 rounded-full bg-orange-400" style={{ width: `${f.flakiness_prob * 100}%` }} />
                          </div>
                          <span className="font-medium text-orange-400" style={{ fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>{(f.flakiness_prob * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>{f.total_errors}</td>
                      <td className="px-4 py-3 max-w-xs truncate" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
                        {f.failure_signatures[0]?.template || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!flakyData.length && <p className="text-center py-12" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>No CI analysis yet. Ensure the CI worker has run.</p>}
            </div>
          </div>
        )}

        {/* ── Team ──────────────────────────────────────────────────────── */}
        {activeTab === 'team' && (
          <div className="space-y-6">
            <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
              <h2 className="text-base font-semibold mb-1" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>Developer Collaboration Graph</h2>
              <p className="text-xs mb-4" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Node size = commit count. Edges = PR review interactions.</p>
              <TeamGraph nodes={teamNodes} edges={teamEdges} />
            </div>
            {busFactor && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                  <h3 className="text-base font-semibold mb-3" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>Bus Factor</h3>
                  <div className="flex items-center gap-3 mb-4">
                    <span className={`text-3xl font-bold ${riskColor(busFactor.overall_bus_factor * 100)}`} style={{ fontFamily: 'var(--heading)' }}>
                      {(busFactor.overall_bus_factor * 100).toFixed(0)}
                    </span>
                    <div>
                      <p className="text-xs mb-1" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>HHI score (0–100)</p>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${riskBg(busFactor.overall_bus_factor * 100)}`} style={{ fontFamily: 'var(--mono)' }}>
                        {busFactor.risk_level.toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {busFactor.contributors.slice(0, 5).map(c => (
                      <div key={c.name} className="flex justify-between" style={{ fontSize: '0.88rem' }}>
                        <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{c.name}</span>
                        <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{(c.share * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
                  <h3 className="text-base font-semibold mb-3" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>Recommendations</h3>
                  <ul className="space-y-2">
                    {busFactor.recommendations.map((r, i) => (
                      <li key={i} className="flex gap-2" style={{ fontSize: '0.88rem', color: 'var(--text)' }}>
                        <span style={{ color: 'var(--accent)' }}>›</span>{r}
                      </li>
                    ))}
                    {!busFactor.recommendations.length && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontFamily: 'var(--mono)' }}>No recommendations.</p>}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Settings ──────────────────────────────────────────────────── */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="rounded-lg p-6 border" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
              <h2 className="text-base font-semibold mb-2" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)' }}>Risk Score Weights</h2>
              <p className="text-sm mb-6" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.83rem' }}>Adjust how much each signal contributes to the unified risk score. Values are automatically normalised.</p>
              <div className="space-y-5">
                {Object.entries(repoConfig).map(([k, v]) => (
                  <div key={k}>
                    <div className="flex justify-between mb-1.5">
                      <label className="capitalize" style={{ color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>{k.replace(/_/g, ' ')}</label>
                      <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>{(v * 100).toFixed(0)}%</span>
                    </div>
                    <input type="range" min={0} max={100} value={Math.round(v * 100)}
                           onChange={e => setRepoConfig(prev => ({ ...prev, [k]: parseInt(e.target.value) / 100 }))}
                           className="w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-lime-500"
                           style={{ background: 'var(--border)' }} />
                  </div>
                ))}
              </div>
              <div className="mt-6 flex gap-3">
                <button onClick={saveWeights}
                        className="px-4 py-2 text-sm font-semibold rounded-md transition-opacity hover:opacity-85"
                        style={{ background: 'var(--accent)', color: '#0d1209', border: 'none', cursor: 'pointer' }}>
                  Save Weights
                </button>
                <button onClick={loadAll}
                        className="px-4 py-2 text-sm rounded-md transition-colors"
                        style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                  Reset
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Chat Sidebar ──────────────────────────────────────────────────── */}
      {chatOpen && (
        <div className="fixed right-0 top-0 h-full w-96 flex flex-col z-50" style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <h3 className="font-semibold" style={{ fontFamily: 'var(--heading)', color: 'var(--text-h)', fontSize: '1rem' }}>AI Assistant</h3>
            <button onClick={() => setChatOpen(false)} className="text-xl leading-none transition-colors" style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {!chatHistory.length && (
              <div className="text-center mt-8">
                <p className="mb-3" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>Ask me anything about this repository:</p>
                {["What are the riskiest files?", "Which tests are flaky?", "Who should review PRs in the auth module?"].map(q => (
                  <button key={q} onClick={() => handleQuickQuestion(q)}
                          className="block mx-auto mb-2 text-left transition-colors hover:underline"
                          style={{ color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: '0.78rem', background: 'none', border: 'none', cursor: 'pointer' }}>
                    "{q}"
                  </button>
                ))}
              </div>
            )}
            {chatHistory.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[85%] px-3 py-2 rounded-lg text-sm" style={
                  m.role === 'user'
                    ? { background: 'var(--accent-bg)', border: '1px solid var(--accent-border)', color: 'var(--text)', borderRadius: '8px 8px 2px 8px' }
                    : { background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '8px 8px 8px 2px' }
                }>{m.content}</div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="px-3 py-2 rounded-lg text-sm animate-pulse" style={{ background: 'var(--surface-raised)', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Thinking…</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="p-3 flex gap-2" style={{ borderTop: '1px solid var(--border)' }}>
            <input ref={chatInputRef} value={chatInput} onChange={e => setChatInput(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                   placeholder="Ask about this repo…"
                   className="flex-1 text-sm rounded-md px-3 py-2 focus:outline-none"
                   style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--sans)' }} />
            <button onClick={() => sendChat()} disabled={!chatInput.trim() || chatLoading}
                    className="px-3 py-2 text-sm font-semibold rounded-md disabled:opacity-50 transition-opacity hover:opacity-85"
                    style={{ background: 'var(--accent)', color: '#0d1209', border: 'none', cursor: 'pointer' }}>
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
