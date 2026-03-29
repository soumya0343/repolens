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

type Tab = 'overview' | 'files' | 'prs' | 'releases' | 'ci' | 'team' | 'settings';

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
};

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

// ── Team Graph (circle layout, pure SVG) ──────────────────────────────────

const TeamGraph: React.FC<{ nodes: TeamNode[]; edges: TeamEdge[] }> = ({ nodes, edges }) => {
  if (!nodes.length) return <p className="text-gray-400 text-center py-8">No developer data yet.</p>;

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
                     stroke="#93c5fd" strokeWidth={Math.min(e.weight, 4)} strokeOpacity={0.6} />;
      })}
      {nodes.map(n => {
        const p = positions[n.id];
        const r = 8 + (n.commit_count / maxCommits) * 14;
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={r} fill="#3b82f6" fillOpacity={0.8} />
            <text x={p.x} y={p.y + r + 12} textAnchor="middle" fontSize={11} fill="#374151">
              {n.id.length > 12 ? n.id.slice(0, 10) + '…' : n.id}
            </text>
            <text x={p.x} y={p.y + r + 22} textAnchor="middle" fontSize={9} fill="#6b7280">
              {n.commit_count} commits
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
  const [repoConfig, setRepoConfig] = useState<Record<string, number>>({ coupling: 0.25, architecture: 0.20, bus_factor: 0.20, collaboration: 0.15, ci: 0.20 });

  const [loading,   setLoading]   = useState(true);
  const [progress,  setProgress]  = useState<{ status: string; details?: string }>({ status: 'Connecting…' });
  const [triggeringBackfill, setTriggeringBackfill] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  // Chat
  const [chatOpen,    setChatOpen]    = useState(false);
  const [chatInput,   setChatInput]   = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const location = useLocation();
  const navigate = useNavigate();
  const repoId = location.state?.repoId;

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
      const [repo, files, prs, risk, dora, flaky, team, bf] = await Promise.all([
        apiFetch<RepoData>(`${API_BASE_URL}/repos/${repoId}`),
        apiFetch<FileData[]>(`${API_BASE_URL}/repos/${repoId}/files`),
        apiFetch<PRData[]>(`${API_BASE_URL}/prs/?repo_id=${repoId}&limit=50`),
        apiFetch<RiskData>(`${API_BASE_URL}/repos/${repoId}/risk`),
        apiFetch<DoraData>(`${API_BASE_URL}/repos/${repoId}/releases`),
        apiFetch<FlakyTest[]>(`${API_BASE_URL}/repos/${repoId}/tests/flaky`),
        apiFetch<{ nodes: TeamNode[]; edges: TeamEdge[] }>(`${API_BASE_URL}/repos/${repoId}/team/graph`),
        apiFetch<BusFactor>(`${API_BASE_URL}/repos/${repoId}/team/bus-factor`),
      ]);
      if (repo)   setRepoData(repo);
      if (files)  setFilesData(files);
      if (prs)    setPrsData(prs);
      if (risk)   { setRiskData(risk); setRepoConfig(risk.weights ?? repoConfig); }
      if (dora)   setDoraData(dora);
      if (flaky)  setFlakyData(flaky);
      if (team)   { setTeamNodes(team.nodes); setTeamEdges(team.edges); }
      if (bf)     setBusFactor(bf);
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

  const sendChat = async () => {
    if (!chatInput.trim() || !repoId) return;
    const userMsg: ChatMessage = { role: 'user', content: chatInput };
    const newHistory = [...chatHistory, userMsg];
    setChatHistory(newHistory);
    setChatInput('');
    setChatLoading(true);
    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/chat`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: chatInput,
          history: newHistory.slice(-10).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      if (r.ok) {
        const data = await r.json();
        setChatHistory(prev => [...prev, { role: 'assistant', content: data.response || 'No response.' }]);
      } else {
        setChatHistory(prev => [...prev, { role: 'assistant', content: 'Error: Could not get a response.' }]);
      }
    } catch {
      setChatHistory(prev => [...prev, { role: 'assistant', content: 'Network error.' }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
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
    { key: 'overview', label: 'Overview' },
    { key: 'files',    label: 'Files' },
    { key: 'prs',      label: 'Pull Requests' },
    { key: 'releases', label: 'Releases' },
    { key: 'ci',       label: 'CI / Tests' },
    { key: 'team',     label: 'Team' },
    { key: 'settings', label: 'Settings' },
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
                        activeTab === t.key
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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

            {/* Risk Score */}
            {riskData && (
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-gray-900">Unified Risk Score</h2>
                  <span className={`text-3xl font-bold ${riskColor(riskData.score)}`}>{riskData.score}/100</span>
                </div>
                <span className={`inline-block mb-4 px-3 py-1 rounded-full text-sm font-medium ${riskBg(riskData.score)}`}>
                  {riskData.label.toUpperCase()}
                </span>
                <div className="space-y-3">
                  {Object.entries(riskData.breakdown).map(([k, v]) => <RiskBar key={k} label={k} value={v} />)}
                </div>
              </div>
            )}

            {/* Backfill progress (only when pending) */}
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

            {/* Summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white rounded-lg shadow p-5">
                <h3 className="text-sm font-medium text-gray-500 mb-3">File Risk Distribution</h3>
                <div className="space-y-2">
                  {[{label:'Critical',min:75},{label:'High',min:55},{label:'Medium',min:30},{label:'Low',min:0}].map(({label,min}) => {
                    const count = filesData.filter(f => f.risk_score >= min && (min===0 || f.risk_score < (min===30?55:min===55?75:200))).length;
                    const colors = { Critical:'text-red-600', High:'text-orange-500', Medium:'text-yellow-600', Low:'text-green-600' } as any;
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
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {['File','Language','Changes','Risk'].map(h => (
                    <th key={h} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filesData.map((f, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 max-w-xs truncate">{f.path}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 capitalize">{f.language}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">{f.changes ?? '—'}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${riskBg(f.risk_score)}`}>
                        {f.risk_score}/100
                      </span>
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
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    {['#','Title','Author','State','Risk','Opened'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {prsData.map(pr => (
                    <tr key={pr.id} className="hover:bg-gray-50">
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
                        {pr.predicted_risk_score != null ? (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskBg(pr.predicted_risk_score)}`}>
                            {pr.predicted_risk_score}/100
                          </span>
                        ) : <span className="text-gray-400 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400">
                        {pr.created_at ? new Date(pr.created_at).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!prsData.length && <p className="text-center py-12 text-gray-400">No pull requests found.</p>}
            </div>
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
                <div className="bg-white rounded-lg shadow p-6">
                  <h3 className="text-base font-semibold text-gray-900 mb-4">DORA Rating Guide</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div><p className="font-medium text-gray-700 mb-2">Deployment Frequency</p>
                      <p className="text-green-600">🏆 Elite: &ge;1/day</p>
                      <p className="text-blue-600">✅ High: &ge;1/week</p>
                      <p className="text-yellow-600">⚠️ Medium: &ge;1/month</p>
                      <p className="text-red-600">🔴 Low: &lt;1/month</p>
                    </div>
                    <div><p className="font-medium text-gray-700 mb-2">Lead Time for Changes</p>
                      <p className="text-green-600">🏆 Elite: &lt;1 hour</p>
                      <p className="text-blue-600">✅ High: &lt;1 day</p>
                      <p className="text-yellow-600">⚠️ Medium: &lt;1 week</p>
                      <p className="text-red-600">🔴 Low: &gt;1 week</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-lg shadow p-12 text-center text-gray-400">
                No release data. Run a backfill to compute DORA metrics.
              </div>
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
                  <tr>
                    {['Run Name','SHA','Conclusion','Flakiness','Errors','Top Failure Pattern'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {flakyData.map(f => (
                    <tr key={f.ci_run_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{f.run_name}</td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-500">{f.head_sha?.slice(0, 7)}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          f.conclusion === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>{f.conclusion}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-gray-100 rounded-full h-1.5">
                            <div className="bg-orange-400 h-1.5 rounded-full" style={{ width: `${f.flakiness_prob * 100}%` }} />
                          </div>
                          <span className="text-sm font-medium text-orange-600">{(f.flakiness_prob * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">{f.total_errors}</td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-400 max-w-xs truncate">
                        {f.failure_signatures[0]?.template || '—'}
                      </td>
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
              <h2 className="text-base font-semibold text-gray-900 mb-4">Developer Collaboration Graph</h2>
              <p className="text-xs text-gray-400 mb-4">Node size = commit count. Edges = PR review interactions.</p>
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
                      <li key={i} className="flex gap-2 text-sm text-gray-700">
                        <span className="text-blue-500 mt-0.5">•</span>{r}
                      </li>
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
                <button onClick={saveWeights}
                        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">
                  Save Weights
                </button>
                <button onClick={loadAll}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">
                  Reset
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

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
                  <button key={q} onClick={() => { setChatInput(q); }}
                          className="block mx-auto mb-2 text-left text-blue-600 hover:underline text-xs">
                    "{q}"
                  </button>
                ))}
              </div>
            )}
            {chatHistory.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
                  m.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-none'
                    : 'bg-gray-100 text-gray-800 rounded-bl-none'
                }`}>{m.content}</div>
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
                    className="px-3 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
