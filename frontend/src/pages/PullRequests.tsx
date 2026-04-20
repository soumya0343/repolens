import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../lib/apiConfig';
import Layout from '../components/Layout';
import Tooltip from '../components/Tooltip';

// ── Types ─────────────────────────────────────────────────────────────────

interface PRData {
  id: string;
  number: number;
  title: string;
  state: string;
  author_login: string;
  created_at: string;
  merged_at?: string;
  predicted_risk_score?: number;
  repo_id?: string;
}

interface RepoMeta { id: string; name: string; owner: string }

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
  if (secs < 3600) return `${Math.floor(secs / 60)}h ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

type PRKind = 'critical' | 'ai_review' | 'clean';

function prKind(score: number): PRKind {
  if (score >= 65) return 'critical';
  if (score >= 25) return 'ai_review';
  return 'clean';
}

const KIND_META: Record<PRKind, { label: string; badgeColor: string; badgeBg: string; borderColor: string; actionLabel: string }> = {
  critical: {
    label: 'CRITICAL RISK',
    badgeColor: 'var(--warning)',
    badgeBg: 'transparent',
    borderColor: 'var(--danger)',
    actionLabel: 'REVIEW CODE',
  },
  ai_review: {
    label: 'AI REVIEW',
    badgeColor: '#4ec9b0',
    badgeBg: 'transparent',
    borderColor: '#4ec9b0',
    actionLabel: 'VIEW ANALYSIS',
  },
  clean: {
    label: 'CLEAN',
    badgeColor: '#000',
    badgeBg: 'var(--accent)',
    borderColor: 'var(--accent)',
    actionLabel: 'APPROVE',
  },
};

function complexityFromScore(score: number): { label: string; color: string; width: string } {
  if (score >= 65) return { label: 'High',   color: 'var(--danger)',  width: '80%' };
  if (score >= 35) return { label: 'Medium',  color: 'var(--warning)', width: '45%' };
  return                   { label: 'Low',    color: 'var(--accent)',  width: '18%' };
}

function statusLine(pr: PRData): { text: string; color: string; icon: string } {
  const score = pr.predicted_risk_score ?? 0;
  if (score >= 65) return { text: `${Math.ceil(score / 30)} Security Flags`, color: 'var(--danger)', icon: '🔒' };
  if (score < 25)  return { text: 'All Checks Passed',        color: 'var(--accent)', icon: '✓' };
  return                   { text: '1 Architectural Suggestion', color: 'var(--warning)', icon: '◈' };
}

// ── Component ─────────────────────────────────────────────────────────────

const PullRequests: React.FC = () => {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate   = useNavigate();

  const [meta,    setMeta]    = useState<RepoMeta | null>(null);
  const [prs,     setPrs]     = useState<PRData[]>([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState('');
  const [filter,  setFilter]  = useState<'all' | 'critical' | 'clean' | 'ai_review'>('all');
  const [visible, setVisible] = useState(10);

  useEffect(() => {
    if (!localStorage.getItem('token')) { navigate('/'); return; }
    if (!repoId) { navigate('/home'); return; }
    Promise.all([
      apiFetch<RepoMeta>(`${API_BASE_URL}/repos/${repoId}`),
      apiFetch<PRData[]>(`${API_BASE_URL}/prs/?repo_id=${repoId}&limit=50`),
    ]).then(([m, p]) => {
      if (m) setMeta(m);
      if (p) setPrs(p);
    }).finally(() => setLoading(false));
  }, [repoId, navigate]);

  const filtered = useMemo(() => {
    let out = prs.filter(pr =>
      pr.title.toLowerCase().includes(search.toLowerCase()) ||
      pr.author_login.toLowerCase().includes(search.toLowerCase()) ||
      String(pr.number).includes(search)
    );
    if (filter !== 'all') {
      out = out.filter(pr => prKind(pr.predicted_risk_score ?? 0) === filter);
    }
    return out;
  }, [prs, search, filter]);

  // Stats
  const openPrs    = prs.filter(p => p.state === 'open');
  const highRisk   = prs.filter(p => (p.predicted_risk_score ?? 0) >= 65);
  const awaiting   = prs.filter(p => p.state === 'open' && (p.predicted_risk_score ?? 0) < 65);
  const autoMerge  = prs.filter(p => (p.predicted_risk_score ?? 0) < 20 && p.state === 'open');

  const repoName = meta ? meta.name : 'repo';

  return (
    <Layout activeNav="prs" repoId={repoId}>
      {/* ── Top bar ─────────────────────────────────────── */}
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '0 2rem', height: 52,
        position: 'sticky', top: 0, zIndex: 10, flexShrink: 0,
      }}>
        <div style={{ position: 'relative', flex: '0 0 auto' }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.78rem' }}>🔍</span>
          <input
            type="text"
            placeholder="Search PRs, branches, or hashes..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3,
              color: 'var(--text)', fontFamily: 'var(--sans)', fontSize: '0.78rem',
              padding: '0.38rem 0.75rem 0.38rem 2rem', outline: 'none', width: 320,
            }}
            onFocus={e => (e.target.style.borderColor = 'var(--accent-border)')}
            onBlur={e => (e.target.style.borderColor = 'var(--border)')}
          />
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <div style={{ width: 30, height: 30, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
            USR
          </div>
        </div>
      </header>

      {/* ── Main ────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: '2rem 2.5rem 3rem', overflowY: 'auto' }}>

        {/* Hero */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
          <div>
            <div style={{
              fontFamily: 'var(--heading)',
              fontSize: 'clamp(2.2rem, 5vw, 3.5rem)',
              fontWeight: 700, color: 'var(--text-h)',
              textTransform: 'uppercase', letterSpacing: '-0.02em', lineHeight: 1,
            }}>
              ACTIVE_PULL_REQUESTS
            </div>
            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: '0.5rem' }}>
              SCANNING {loading ? '...' : prs.length} OPEN REQUESTS ACROSS {repoName.toUpperCase()}
            </div>
            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.6rem', maxWidth: 540, lineHeight: 1.5, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              Each pull request is scored by AI based on how risky the code change is — touching critical files, high churn areas, or complex logic raises the score.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', flexShrink: 0, marginTop: '0.25rem' }}>
            <select
              value={filter}
              onChange={e => setFilter(e.target.value as typeof filter)}
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3,
                color: 'var(--text)', fontFamily: 'var(--sans)', fontSize: '0.72rem',
                fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
                padding: '0.45rem 0.85rem', cursor: 'pointer', outline: 'none',
              }}
            >
              <option value="all">≡ FILTER</option>
              <option value="critical">CRITICAL</option>
              <option value="ai_review">AI REVIEW</option>
              <option value="clean">CLEAN</option>
            </select>
            <button style={{
              background: 'var(--accent)', border: 'none', borderRadius: 3,
              color: '#000', fontFamily: 'var(--sans)', fontSize: '0.72rem',
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              padding: '0.45rem 1rem', cursor: 'pointer', transition: 'opacity 0.15s',
              display: 'flex', alignItems: 'center', gap: '0.4rem',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.85'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
            >
              + NEW PR
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', margin: '1.75rem 0' }}>
          {/* Total Open */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1.1rem 1.25rem' }}>
            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>TOTAL OPEN</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
              <span style={{ fontFamily: 'var(--heading)', fontSize: '2.2rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '-0.02em' }}>
                {loading ? '—' : openPrs.length}
              </span>
              {!loading && openPrs.length > 0 && (
                <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 2 }}>
                  ↑ {Math.round((openPrs.length / Math.max(prs.length, 1)) * 100)}%
                </span>
              )}
            </div>
          </div>

          {/* High Risk */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1.1rem 1.25rem' }}>
            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: 4 }}>HIGH RISK <Tooltip text="PRs with a predicted risk score ≥ 65. These touch sensitive or frequently-broken areas and should be reviewed carefully before merging." position="bottom" /></div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--heading)', fontSize: '2.2rem', fontWeight: 700, color: highRisk.length > 0 ? 'var(--danger)' : 'var(--text-h)', letterSpacing: '-0.02em' }}>
                {loading ? '—' : String(highRisk.length).padStart(2, '0')}
              </span>
              {highRisk.length > 0 && <span style={{ fontSize: '1.1rem', color: 'var(--warning)' }}>⚠</span>}
            </div>
          </div>

          {/* Awaiting Review */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1.1rem 1.25rem' }}>
            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>AWAITING REVIEW</div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--heading)', fontSize: '2.2rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '-0.02em' }}>
                {loading ? '—' : awaiting.length}
              </span>
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>···</span>
            </div>
          </div>

          {/* AI Auto-merge eligible */}
          <div style={{
            background: 'var(--surface)', borderRadius: 3, padding: '1.1rem 1.25rem',
            border: '1px solid var(--accent-border)',
          }}>
            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: 4 }}>AI AUTO-MERGE ELIGIBLE <Tooltip text="PRs with a risk score below 20 — low-risk changes like docs, typos, or small config tweaks that are safe to merge without deep review." position="bottom" /></div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--heading)', fontSize: '2.2rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '-0.02em' }}>
                {loading ? '—' : String(autoMerge.length).padStart(2, '0')}
              </span>
              <span style={{ fontSize: '1rem', color: 'var(--accent)' }}>◎</span>
            </div>
          </div>
        </div>

        {/* Priority queue */}
        <div style={{ marginBottom: '0.75rem' }}>
          <span style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            PRIORITY QUEUE
          </span>
        </div>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {[1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 120, borderRadius: 3 }} />)}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
            NO_PRS_FOUND //
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {filtered.slice(0, visible).map(pr => {
                const score   = pr.predicted_risk_score ?? 0;
                const kind    = prKind(score);
                const meta_k  = KIND_META[kind];
                const complex = complexityFromScore(score);
                const status  = statusLine(pr);

                return (
                  <div key={pr.id} style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderLeft: `3px solid ${meta_k.borderColor}`,
                    borderRadius: 3,
                    padding: '1.1rem 1.25rem 1.1rem 1.5rem',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: '1.5rem',
                    alignItems: 'center',
                    transition: 'border-color 0.15s',
                    cursor: 'pointer',
                  }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = `${meta_k.borderColor}`; (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-raised)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLDivElement).style.background = 'var(--surface)'; }}
                  >
                    {/* Left: info */}
                    <div>
                      {/* Badges row */}
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{
                          fontFamily: 'var(--sans)', fontSize: '0.62rem', fontWeight: 700,
                          color: meta_k.badgeColor, background: meta_k.badgeBg,
                          border: `1px solid ${meta_k.badgeColor}`,
                          padding: '2px 8px', borderRadius: 2, letterSpacing: '0.08em', textTransform: 'uppercase',
                        }}>
                          {meta_k.label}
                        </span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                          #{pr.number}
                        </span>
                        <span style={{
                          fontFamily: 'var(--sans)', fontSize: '0.62rem', color: 'var(--text-muted)',
                          background: 'var(--surface-raised)', border: '1px solid var(--border)',
                          padding: '2px 8px', borderRadius: 2,
                        }}>
                          {repoName}
                        </span>
                      </div>

                      {/* Title */}
                      <div style={{
                        fontFamily: 'var(--sans)', fontSize: '1rem', fontWeight: 600,
                        color: 'var(--text-h)', marginBottom: '0.5rem', lineHeight: 1.3,
                      }}>
                        {pr.title}
                      </div>

                      {/* Meta row */}
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <span>👤</span> {pr.author_login}
                        </span>
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <span>🕐</span> {timeAgo(pr.created_at)}
                        </span>
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: status.color, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <span>{status.icon}</span> {status.text}
                        </span>
                      </div>
                    </div>

                    {/* Right: complexity + action */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', minWidth: 180 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.7rem', color: 'var(--text-muted)' }}>Complexity:</span>
                        <span style={{ fontFamily: 'var(--sans)', fontSize: '0.7rem', fontWeight: 700, color: complex.color }}>{complex.label}</span>
                      </div>
                      <div style={{ height: 4, background: 'var(--surface-raised)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', background: complex.color, borderRadius: 2, width: complex.width, transition: 'width 0.4s ease' }} />
                      </div>
                      <button
                        style={{
                          background: kind === 'clean' ? 'var(--accent)' : 'transparent',
                          border: kind === 'clean' ? 'none' : `1px solid ${meta_k.borderColor}`,
                          color: kind === 'clean' ? '#000' : meta_k.borderColor,
                          fontFamily: 'var(--sans)', fontSize: '0.72rem', fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '0.08em',
                          padding: '0.5rem 0', borderRadius: 3, cursor: 'pointer', width: '100%',
                          transition: 'opacity 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.8'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
                      >
                        {meta_k.actionLabel}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Load more */}
            {visible < filtered.length && (
              <button
                onClick={() => setVisible(v => v + 10)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  margin: '1.5rem auto 0', background: 'transparent', border: 'none',
                  fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 600,
                  color: 'var(--accent)', letterSpacing: '0.08em', textTransform: 'uppercase',
                  cursor: 'pointer', transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.7'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
              >
                LOAD MORE ▾
              </button>
            )}
          </>
        )}
      </main>
    </Layout>
  );
};

export default PullRequests;
