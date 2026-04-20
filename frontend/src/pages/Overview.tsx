import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../lib/apiConfig';
import Layout from '../components/Layout';
import Tooltip from '../components/Tooltip';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────

interface RepoMeta { id: string; name: string; owner: string; synced_at?: string; stats?: { commits: number; pull_requests: number } }

interface RiskData {
  score: number;
  label: string;
  breakdown: Record<string, number>;
  weights?: Record<string, number>;
}

interface FileData {
  path: string;
  risk_score: number;
  violations: string[];
  secret_count?: number;
  highest_secret_severity?: string | null;
}

interface PRData {
  id: string; number: number; title: string; state: string;
  author_login: string; created_at: string; merged_at?: string;
  predicted_risk_score?: number;
}

interface DoraData {
  deployment_frequency: { value: number; rating: string; label: string };
  lead_time_for_changes: { value: number; rating: string; label: string };
  change_failure_rate: { value: number; rating: string; label: string };
  time_to_restore: { value: number | null; rating: string; label: string };
}

interface FlakyTest { ci_run_id: string; run_name: string; flakiness_prob: number; conclusion: string }

interface ScorePoint { recorded_at: string; score: number }

interface SecretFinding {
  id: string;
  source: string;
  pr_number?: number | null;
  file_path: string;
  line_number: number;
  detector: string;
  severity: string;
  confidence: number;
  masked_value: string;
  status: string;
  message?: string;
  first_seen_at?: string;
  last_seen_at?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const authHdr = () => ({ Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` });

async function apiFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHdr() });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function riskBadge(score: number): { label: string; color: string; bg: string } {
  if (score >= 75) return { label: 'CRITICAL RISK', color: 'var(--danger)', bg: 'rgba(255,65,65,0.12)' };
  if (score >= 55) return { label: 'HIGH RISK',     color: 'var(--warning)', bg: 'rgba(255,204,0,0.12)' };
  if (score >= 30) return { label: 'MEDIUM RISK',   color: '#aaa', bg: 'var(--surface-raised)' };
  return             { label: 'LOW RISK',           color: 'var(--accent)', bg: 'var(--accent-bg)' };
}

function riskColor(score: number): string {
  if (score >= 75) return 'var(--danger)';
  if (score >= 55) return 'var(--warning)';
  return 'var(--accent)';
}

function prStatus(pr: PRData): { label: string; color: string } {
  const risk = pr.predicted_risk_score ?? 0;
  if (pr.state === 'closed' && pr.merged_at) {
    return risk >= 60 ? { label: 'WARN', color: 'var(--warning)' } : { label: 'PASS', color: 'var(--accent)' };
  }
  if (risk >= 75) return { label: 'HIGH', color: 'var(--danger)' };
  if (risk >= 40) return { label: 'WARN', color: 'var(--warning)' };
  return { label: 'PASS', color: 'var(--accent)' };
}

function prHexId(pr: PRData): string {
  return '0x' + (pr.number * 4096 + (pr.id.charCodeAt(0) ?? 0)).toString(16).toUpperCase().slice(0, 5);
}

// ── Sub-components ────────────────────────────────────────────────────────

const Card: React.FC<{ style?: React.CSSProperties; children: React.ReactNode }> = ({ style, children }) => (
  <div style={{
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 3, padding: '1.25rem 1.5rem', ...style,
  }}>
    {children}
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700,
    color: 'var(--text-muted)', letterSpacing: '0.14em', textTransform: 'uppercase',
    marginBottom: '0.25rem',
  }}>
    {children}
  </div>
);

// ── Main ──────────────────────────────────────────────────────────────────

const Overview: React.FC = () => {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();

  const [meta,         setMeta]         = useState<RepoMeta | null>(null);
  const [risk,         setRisk]         = useState<RiskData | null>(null);
  const [files,        setFiles]        = useState<FileData[]>([]);
  const [prs,          setPrs]          = useState<PRData[]>([]);
  const [dora,         setDora]         = useState<DoraData | null>(null);
  const [flaky,        setFlaky]        = useState<FlakyTest[]>([]);
  const [history,      setHistory]      = useState<ScorePoint[]>([]);
  const [secrets,      setSecrets]      = useState<SecretFinding[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [backfilling,  setBackfilling]  = useState(false);
  const [backfillMsg,  setBackfillMsg]  = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!repoId) return;
    setLoading(true);
    const [metaR, riskR, filesR, prsR, doraR, flakyR, histR, secretsR] = await Promise.all([
      apiFetch<RepoMeta>(`${API_BASE_URL}/repos/${repoId}`),
      apiFetch<RiskData>(`${API_BASE_URL}/repos/${repoId}/risk`),
      apiFetch<FileData[]>(`${API_BASE_URL}/repos/${repoId}/files`),
      apiFetch<PRData[]>(`${API_BASE_URL}/prs/?repo_id=${repoId}&limit=10`),
      apiFetch<DoraData>(`${API_BASE_URL}/repos/${repoId}/releases`),
      apiFetch<FlakyTest[]>(`${API_BASE_URL}/repos/${repoId}/tests/flaky`),
      apiFetch<ScorePoint[]>(`${API_BASE_URL}/repos/${repoId}/score/history?days=30`),
      apiFetch<SecretFinding[]>(`${API_BASE_URL}/repos/${repoId}/secrets`),
    ]);
    if (metaR)  setMeta(metaR);
    if (riskR)  setRisk(riskR);
    if (filesR) setFiles(filesR);
    if (prsR)   setPrs(prsR);
    if (doraR)  setDora(doraR);
    if (flakyR) setFlaky(flakyR);
    if (histR)  setHistory(histR);
    if (secretsR) setSecrets(secretsR);
    setLoading(false);
  }, [repoId]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { navigate('/'); return; }
    if (!repoId) { navigate('/home'); return; }
    loadAll();
  }, [repoId, navigate, loadAll]);

  // Poll every 30s while ingestion is in progress (synced_at is null)
  useEffect(() => {
    if (loading || meta?.synced_at) return;
    const id = setInterval(loadAll, 30_000);
    return () => clearInterval(id);
  }, [loading, meta?.synced_at, loadAll]);

  const triggerBackfill = async () => {
    if (!repoId) return;
    setBackfilling(true); setBackfillMsg(null);
    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/backfill`, { method: 'POST', headers: authHdr() });
      if (r.ok) {
        setBackfillMsg('Backfill queued.');
        toast.success('Backfill queued — data will update shortly.');
      } else {
        setBackfillMsg('Failed to trigger backfill.');
        toast.error('Failed to trigger backfill.');
      }
    } catch {
      setBackfillMsg('Error triggering backfill.');
      toast.error('Error triggering backfill. Check your connection.');
    }
    finally { setBackfilling(false); }
  };

  const updateSecretStatus = async (findingId: string, status: string) => {
    if (!repoId) return;
    const r = await fetch(`${API_BASE_URL}/repos/${repoId}/secrets/${findingId}`, {
      method: 'PATCH',
      headers: { ...authHdr(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (r.ok) {
      const updated = await r.json();
      setSecrets(prev => prev.map(f => f.id === findingId ? updated : f));
      toast.success(`Secret marked as ${status}.`);
    } else {
      toast.error('Failed to update secret status.');
    }
  };

  // ── Derived values ───────────────────────────────────────────────────────

  const score     = risk?.score ?? null;
  const badge     = score !== null ? riskBadge(score) : null;
  const scoreColor = score !== null ? riskColor(score) : 'var(--accent)';

  // 30d trend from history
  const trend = history.length >= 2
    ? Math.round(history[history.length - 1].score - history[0].score)
    : null;

  // Component metrics from breakdown (0–100 scale)
  const breakdown = risk?.breakdown ?? {};
  const components: { label: string; key: string; tip: string }[] = [
    { label: 'COUPLING',   key: 'coupling',      tip: 'How often files change together. High coupling means a bug in one file likely breaks others.' },
    { label: 'ARCH',       key: 'architecture',  tip: 'Whether the codebase follows its own structural rules — e.g. no circular imports, no layer violations.' },
    { label: 'BUS FACTOR', key: 'bus_factor',    tip: 'Knowledge concentration risk. A score of 100 means one person owns everything — if they leave, the team is stuck.' },
    { label: 'COLLAB',     key: 'collaboration', tip: 'How well knowledge is shared across the team. Low scores mean isolated contributors who rarely overlap.' },
    { label: 'CI SCORE',   key: 'ci',            tip: 'Reliability of your CI pipeline. Factors in flaky tests, failure rates, and build duration trends.' },
    { label: 'SECRETS',    key: 'secrets',       tip: 'Presence of leaked credentials, API keys, or tokens in code. Any active finding here is a critical risk.' },
  ];

  // File risk distribution
  const distrib = {
    critical: files.filter(f => f.risk_score >= 75).length,
    high:     files.filter(f => f.risk_score >= 55 && f.risk_score < 75).length,
    medium:   files.filter(f => f.risk_score >= 30 && f.risk_score < 55).length,
    low:      files.filter(f => f.risk_score < 30).length,
  };
  const maxDistrib = Math.max(...Object.values(distrib), 1);

  const activeSecrets = secrets.filter(f => f.status === 'active');
  const criticalSecrets = activeSecrets.filter(f => f.severity === 'critical').length;
  const highSecrets = activeSecrets.filter(f => f.severity === 'high').length;
  const criticalFiles = files.filter(f => f.risk_score >= 75 || f.violations?.length > 0 || (f.secret_count ?? 0) > 0);
  const recentPrs = prs.slice(0, 5);
  const repoPath = meta ? `/${meta.owner}/${meta.name}`.toUpperCase() : '...';

  return (
    <Layout activeNav="overview" repoId={repoId}>
      {/* ── Top bar ─────────────────────────────────────── */}
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '0 2rem', height: 52,
        position: 'sticky', top: 0, zIndex: 10, flexShrink: 0,
        fontFamily: 'var(--mono)',
      }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--accent)', fontWeight: 600, letterSpacing: '0.06em' }}>
          SYSTEM_OVERVIEW
        </span>
        <span style={{ color: 'var(--border-bright)' }}>|</span>
        <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.06em' }}>
          LIVE_LOGS
        </button>
        <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.06em' }}>
          METRICS
        </button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-muted)', letterSpacing: '0.04em', marginLeft: '0.5rem' }}>
          // {repoPath}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button
            onClick={triggerBackfill}
            disabled={backfilling}
            style={{
              background: 'transparent', border: '1px solid var(--accent)',
              color: 'var(--accent)', fontFamily: 'var(--sans)', fontSize: '0.7rem',
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              padding: '0.35rem 0.9rem', borderRadius: 3, cursor: backfilling ? 'not-allowed' : 'pointer',
              opacity: backfilling ? 0.6 : 1, transition: 'background 0.15s',
            }}
            onMouseEnter={e => { if (!backfilling) (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-bg)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          >
            {backfilling ? 'RUNNING...' : 'DEPLOY_NODE'}
          </button>
          <div style={{
            width: 30, height: 30, background: 'var(--surface-raised)',
            border: '1px solid var(--border)', borderRadius: 3,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 600,
            color: 'var(--text-muted)', cursor: 'pointer',
          }}>USR</div>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: '2rem 2rem 3rem', overflowY: 'auto' }}>

        {/* Hero heading */}
        <div style={{ marginBottom: '2rem', lineHeight: 0.88 }}>
          <div style={{
            fontFamily: 'var(--heading)',
            fontSize: 'clamp(3rem, 7vw, 5.5rem)',
            fontWeight: 700,
            color: 'var(--text-h)',
            textTransform: 'uppercase',
            letterSpacing: '-0.02em',
          }}>
            SYSTEM
          </div>
          <div style={{
            fontFamily: 'var(--heading)',
            fontSize: 'clamp(3rem, 7vw, 5.5rem)',
            fontWeight: 700,
            color: 'var(--text-h)',
            textTransform: 'uppercase',
            letterSpacing: '-0.02em',
          }}>
            OVERVIEW
          </div>
        </div>

        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: '1rem' }}>
            {[1,2,3,4,5,6].map(i => (
              <div key={i} className="skeleton" style={{ height: 140, borderRadius: 3 }} />
            ))}
          </div>
        ) : !meta?.synced_at ? (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--accent-border)',
            borderRadius: 6, padding: '2rem', textAlign: 'center',
          }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem', color: 'var(--accent)', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>
              ⟳ BACKFILL IN PROGRESS
            </div>
            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Ingesting commits, PRs, and CI data from GitHub. This usually takes ~1 minute.
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
              Page will refresh automatically when data is ready.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: '1rem', alignItems: 'start' }}>

            {/* ── LEFT COLUMN ────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

              {/* Unified Risk Score */}
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
                      UNIFIED RISK SCORE
                      <Tooltip text="A single 0–100 number representing overall repo health. It blends file churn, code ownership concentration, architectural violations, CI stability, secret leaks, and collaboration patterns." position="right" />
                    </div>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                      Aggregated system vulnerability metric
                    </div>
                  </div>
                  {badge && (
                    <span style={{
                      fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700,
                      background: badge.bg, color: badge.color,
                      padding: '4px 10px', borderRadius: 3, letterSpacing: '0.1em',
                      border: `1px solid ${badge.color}33`,
                    }}>
                      {badge.label}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', margin: '1rem 0 0.75rem' }}>
                  <span style={{
                    fontFamily: 'var(--heading)',
                    fontSize: 'clamp(3.5rem, 8vw, 5rem)',
                    fontWeight: 700,
                    color: scoreColor,
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                  }}>
                    {score !== null ? score.toFixed(1) : '—'}
                  </span>
                  <span style={{
                    fontFamily: 'var(--heading)', fontSize: '1.5rem', fontWeight: 700,
                    color: 'var(--text-muted)', letterSpacing: '-0.01em',
                  }}>
                    /100
                  </span>

                  {trend !== null && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginLeft: '1rem' }}>
                      <span style={{ fontSize: '1rem', color: trend > 0 ? 'var(--danger)' : 'var(--accent)' }}>
                        {trend > 0 ? '↗' : '↘'}
                      </span>
                      <span style={{
                        fontFamily: 'var(--sans)', fontSize: '0.85rem', fontWeight: 600,
                        color: trend > 0 ? 'var(--danger)' : 'var(--accent)',
                      }}>
                        {trend > 0 ? '+' : ''}{trend} pts
                      </span>
                      <span style={{ fontFamily: 'var(--sans)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        30d trend
                      </span>
                    </div>
                  )}
                </div>
              </Card>

              {/* Component Metrics */}
              <div>
                <div style={{
                  fontFamily: 'var(--sans)', fontSize: '0.8rem', fontWeight: 700,
                  color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase',
                  marginBottom: '0.75rem',
                }}>
                  COMPONENT METRICS
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '0.75rem' }}>
                  {components.map(({ label, key, tip }) => {
                    const val = breakdown[key] !== undefined ? Math.round(breakdown[key]) : null;
                    const col = val !== null ? riskColor(val) : 'var(--text-muted)';
                    return (
                      <Card key={key} style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <SectionLabel>{label}</SectionLabel>
                          <Tooltip text={tip} position="bottom" />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                          <span style={{ fontFamily: 'var(--heading)', fontSize: '1.5rem', fontWeight: 700, color: val !== null ? col : 'var(--text-muted)', letterSpacing: '-0.02em' }}>
                            {val !== null ? val : '—'}
                          </span>
                          {val !== null && (
                            <span style={{ fontFamily: 'var(--sans)', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                              /100
                            </span>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>

              {/* Secret Findings */}
              <Card style={{ padding: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontFamily: 'var(--heading)', fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    SECRET FINDINGS
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: activeSecrets.length > 0 ? 'var(--danger)' : 'var(--accent)' }}>
                    {activeSecrets.length} ACTIVE
                  </span>
                </div>
                {secrets.length === 0 ? (
                  <div style={{ padding: '1.5rem', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                    NO_SECRET_FINDINGS //
                  </div>
                ) : secrets.slice(0, 8).map(f => (
                  <div key={f.id} style={{
                    display: 'grid', gridTemplateColumns: '92px 1.4fr 1fr 90px 160px',
                    alignItems: 'center', gap: '0.75rem', padding: '0.8rem 1.5rem',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <span style={{
                      fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700,
                      color: f.severity === 'critical' ? 'var(--danger)' : f.severity === 'high' ? 'var(--warning)' : 'var(--text-muted)',
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                    }}>
                      {f.severity}
                    </span>
                    <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-h)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.file_path}:{f.line_number}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.detector}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--accent)' }}>
                      {f.masked_value}
                    </span>
                    <select
                      value={f.status}
                      onChange={e => updateSecretStatus(f.id, e.target.value)}
                      style={{
                        background: 'var(--surface-raised)', color: 'var(--text)',
                        border: '1px solid var(--border)', borderRadius: 3,
                        fontFamily: 'var(--sans)', fontSize: '0.68rem', padding: '0.35rem',
                      }}
                    >
                      <option value="active">active</option>
                      <option value="resolved">resolved</option>
                      <option value="false_positive">false positive</option>
                      <option value="accepted_risk">accepted risk</option>
                    </select>
                  </div>
                ))}
              </Card>

              {/* File Risk Distribution + Flaky (side by side) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>

                {/* File Risk Distribution */}
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      FILE RISK DISTRIBUTION
                    </div>
                    <span style={{ color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem' }}>≡</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    {([
                      { label: 'CRITICAL', count: distrib.critical, color: 'var(--danger)',  bg: 'rgba(255,65,65,0.25)' },
                      { label: 'HIGH',     count: distrib.high,     color: 'var(--warning)', bg: 'rgba(255,150,0,0.35)' },
                      { label: 'MEDIUM',   count: distrib.medium,   color: '#ccaa00',        bg: 'rgba(220,190,0,0.35)' },
                      { label: 'LOW',      count: distrib.low,      color: 'var(--accent)',  bg: 'rgba(0,255,65,0.3)' },
                    ] as const).map(row => (
                      <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 28px', alignItems: 'center', gap: '0.6rem' }}>
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700, color: row.color, letterSpacing: '0.08em' }}>
                          {row.label}
                        </span>
                        <div style={{ height: 8, background: 'var(--surface-raised)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', borderRadius: 2,
                            background: row.bg,
                            width: `${Math.max((row.count / maxDistrib) * 100, row.count > 0 ? 4 : 0)}%`,
                            transition: 'width 0.4s ease',
                          }} />
                        </div>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                          {row.count}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>

                {/* Top Flaky CI Runs */}
                <Card>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '1rem' }}>
                    TOP FLAKY CI RUNS
                  </div>
                  {flaky.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', padding: '1.5rem 0' }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: '50%',
                        background: 'var(--accent)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <span style={{ color: '#000', fontSize: '1.1rem' }}>✓</span>
                      </div>
                      <span style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        No flaky tests detected.
                      </span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {flaky.slice(0, 4).map(f => (
                        <div key={f.ci_run_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.run_name}
                          </span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--warning)', flexShrink: 0 }}>
                            {Math.round(f.flakiness_prob * 100)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              {/* Recent Scans */}
              <Card style={{ padding: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontFamily: 'var(--heading)', fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    RECENT SCANS
                  </span>
                  <button
                    onClick={() => navigate(`/repo/${repoId}/prs`)}
                    style={{ background: 'transparent', border: 'none', fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer', transition: 'color 0.1s' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                  >
                    VIEW ALL -&gt;
                  </button>
                </div>
                {recentPrs.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                    NO_SCAN_HISTORY //
                  </div>
                ) : recentPrs.map((pr, i) => {
                  const s = prStatus(pr);
                  return (
                    <div key={pr.id} style={{
                      display: 'grid', gridTemplateColumns: '90px 1.2fr 1.5fr 72px 64px',
                      alignItems: 'center', gap: '1rem', padding: '0.85rem 1.5rem',
                      borderBottom: i < recentPrs.length - 1 ? '1px solid var(--border)' : 'none',
                      cursor: 'pointer', transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-raised)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                    >
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{prHexId(pr)}</span>
                      <span style={{ fontFamily: 'var(--sans)', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-h)', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr.title}</span>
                      <span style={{ fontFamily: 'var(--sans)', fontSize: '0.7rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{pr.number} by {pr.author_login}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <div style={{ width: 7, height: 7, borderRadius: 1, background: s.color, flexShrink: 0 }} />
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 700, color: s.color, letterSpacing: '0.08em' }}>{s.label}</span>
                      </div>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'right' }}>{timeAgo(pr.created_at)}</span>
                    </div>
                  );
                })}
              </Card>
            </div>

            {/* ── RIGHT COLUMN ───────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

              {/* Status / Backfill widget */}
              <Card style={{ textAlign: 'center', padding: '1.75rem 1.25rem' }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: '2rem', color: 'var(--accent)',
                  marginBottom: '0.75rem', lineHeight: 1,
                }}>
                  &#x7B;&#x7D;
                </div>
                <div style={{ fontFamily: 'var(--sans)', fontSize: '1rem', fontWeight: 600, color: 'var(--text-h)', marginBottom: '0.3rem' }}>
                  {meta ? `${meta.owner}/${meta.name}` : 'Connecting...'}
                </div>
                <div style={{ fontFamily: 'var(--sans)', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
                  {meta ? `Last synced ${meta.synced_at ? timeAgo(meta.synced_at) : 'never'}` : 'Awaiting system handshake'}
                </div>
                {backfillMsg && (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--accent)', marginBottom: '0.75rem' }}>
                    {backfillMsg}
                  </div>
                )}
                <button
                  onClick={triggerBackfill}
                  disabled={backfilling}
                  style={{
                    background: 'transparent', border: '1px solid var(--accent)',
                    color: 'var(--accent)', fontFamily: 'var(--sans)', fontSize: '0.75rem',
                    fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                    padding: '0.6rem 1.25rem', borderRadius: 3, cursor: backfilling ? 'not-allowed' : 'pointer',
                    opacity: backfilling ? 0.6 : 1, width: '100%', transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { if (!backfilling) (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-bg)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                >
                  {backfilling ? 'RUNNING...' : 'TRIGGER BACKFILL'}
                </button>
              </Card>

              {/* DORA Snapshot */}
              <Card>
                <div style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '1rem' }}>
                  DORA SNAPSHOT
                </div>
                {dora ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                    {([
                      { label: 'Deploy Freq',    value: `${dora.deployment_frequency.value ?? 0} /day` },
                      { label: 'Lead Time',      value: `${dora.lead_time_for_changes.value ?? 0}h` },
                      { label: 'Change Failure', value: dora.change_failure_rate.value != null ? `${dora.change_failure_rate.value}%` : '—' },
                      { label: 'Time to Restore', value: dora.time_to_restore.value != null ? `${dora.time_to_restore.value}h` : '—' },
                    ] as const).map((row, i, arr) => (
                      <div key={row.label} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.65rem 0',
                        borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                      }}>
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.8rem', color: 'var(--text)' }}>
                          {row.label}
                        </span>
                        <span style={{ fontFamily: 'var(--heading)', fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent)', letterSpacing: '-0.01em' }}>
                          {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                    NO_DORA_DATA //
                  </div>
                )}
              </Card>

              {/* Active Mitigation — only when high risk */}
              {risk && risk.score >= 55 && (
                <Card>
                  <SectionLabel>ACTIVE MITIGATION</SectionLabel>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-h)', lineHeight: 1.5, margin: '0.5rem 0 1rem' }}>
                    {risk.score >= 75
                      ? 'Critical risk detected. Immediate review of high-risk files required.'
                      : 'Elevated risk level. Review flagged files and recent PR changes.'}
                  </div>
                  <button
                    onClick={() => navigate(`/repo/${repoId}/files`)}
                    style={{
                      background: 'transparent', border: '1px solid var(--accent)',
                      color: 'var(--accent)', fontFamily: 'var(--sans)', fontSize: '0.72rem',
                      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                      padding: '0.55rem 1rem', borderRadius: 3, cursor: 'pointer', width: '100%',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-bg)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                  >
                    VIEW FILES
                  </button>
                </Card>
              )}

              {/* Commits + Files Scanned + Critical Vulns + Secrets */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <Card style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <SectionLabel>TOTAL COMMITS</SectionLabel>
                    <Tooltip text="Total number of commits ingested and analyzed for this repository." position="top" />
                  </div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '-0.02em', margin: '0.4rem 0 0.25rem' }}>
                    {meta?.stats?.commits != null ? meta.stats.commits.toLocaleString() : '—'}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                    // analyzed commits
                  </div>
                </Card>
                <Card style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <SectionLabel>FILES SCANNED</SectionLabel>
                    <Tooltip text="All files that appear in at least one commit. Sorted by risk — the most dangerous files surface first." position="top" />
                  </div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '-0.02em', margin: '0.4rem 0 0.25rem' }}>
                    {files.length > 0 ? files.length.toLocaleString() : '—'}
                  </div>
                  {files.length > 0 && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--accent)' }}>
                      → {criticalFiles.length} flagged
                    </div>
                  )}
                </Card>
                <Card style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <SectionLabel>CRITICAL VULNS</SectionLabel>
                    <Tooltip text="Files with a risk score ≥ 75, known architectural violations, or active secret leaks. These need immediate attention." position="top" />
                  </div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '1.6rem', fontWeight: 700, color: criticalFiles.length > 0 ? 'var(--accent)' : 'var(--text-h)', letterSpacing: '-0.02em', margin: '0.4rem 0 0.25rem' }}>
                    {String(criticalFiles.length).padStart(2, '0')}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                    // {criticalFiles.length > 0 ? 'Awaiting resolution' : 'All clear'}
                  </div>
                </Card>
                <Card style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <SectionLabel>SECRETS FOUND</SectionLabel>
                    <Tooltip text="Hardcoded API keys, passwords, tokens, or credentials detected in source code. Active findings are a security emergency." position="top" />
                  </div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '1.6rem', fontWeight: 700, color: activeSecrets.length > 0 ? 'var(--danger)' : 'var(--text-h)', letterSpacing: '-0.02em', margin: '0.4rem 0 0.25rem' }}>
                    {String(activeSecrets.length).padStart(2, '0')}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                    // {criticalSecrets} critical / {highSecrets} high
                  </div>
                </Card>
              </div>

            </div>
          </div>
        )}
      </main>
    </Layout>
  );
};

export default Overview;
