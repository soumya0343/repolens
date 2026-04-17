import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../lib/apiConfig';
import Layout from '../components/Layout';

interface RepoMeta {
  id: string;
  name: string;
  owner: string;
  synced_at?: string;
}

interface RiskData {
  score: number;
  label: string;
  breakdown: Record<string, number>;
}

interface FileData {
  path: string;
  risk_score: number;
  violations: string[];
}

interface PRData {
  id: string;
  number: number;
  title: string;
  state: string;
  author_login: string;
  created_at: string;
  merged_at?: string;
  predicted_risk_score?: number;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function prStatus(pr: PRData): { label: string; color: string } {
  const risk = pr.predicted_risk_score ?? 0;
  if (pr.state === 'closed' && pr.merged_at) {
    if (risk >= 60) return { label: 'WARN', color: 'var(--warning)' };
    return { label: 'PASS', color: 'var(--accent)' };
  }
  if (risk >= 75) return { label: 'HIGH', color: 'var(--danger)' };
  if (risk >= 40) return { label: 'WARN', color: 'var(--warning)' };
  return { label: 'PASS', color: 'var(--accent)' };
}

function prHexId(pr: PRData): string {
  return '0x' + (pr.number * 4096 + (pr.id.charCodeAt(0) ?? 0))
    .toString(16).toUpperCase().slice(0, 5);
}

const Overview: React.FC = () => {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<RepoMeta | null>(null);
  const [risk, setRisk] = useState<RiskData | null>(null);
  const [files, setFiles] = useState<FileData[]>([]);
  const [prs, setPrs] = useState<PRData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { navigate('/'); return; }
    if (!repoId) { navigate('/home'); return; }

    const headers = { Authorization: `Bearer ${token}` };

    Promise.allSettled([
      axios.get(`${API_BASE_URL}/repos/${repoId}`, { headers }),
      axios.get(`${API_BASE_URL}/repos/${repoId}/risk`, { headers }),
      axios.get(`${API_BASE_URL}/repos/${repoId}/files`, { headers }),
      axios.get(`${API_BASE_URL}/repos/${repoId}/prs`, { headers }),
    ]).then(([metaRes, riskRes, filesRes, prsRes]) => {
      if (metaRes.status === 'fulfilled') setMeta(metaRes.value.data);
      if (riskRes.status === 'fulfilled') setRisk(riskRes.value.data);
      if (filesRes.status === 'fulfilled') setFiles(filesRes.value.data ?? []);
      if (prsRes.status === 'fulfilled') setPrs(prsRes.value.data ?? []);
    }).finally(() => setLoading(false));
  }, [repoId, navigate]);

  const riskScore = risk ? (risk.score / 10).toFixed(1) : '—';
  const riskLabel = risk
    ? risk.score >= 75 ? 'CRITICAL THREAT LEVEL'
    : risk.score >= 55 ? 'ELEVATED THREAT LEVEL'
    : risk.score >= 30 ? 'MODERATE THREAT LEVEL'
    : 'LOW THREAT LEVEL'
    : '';

  const riskAccentColor = risk
    ? risk.score >= 75 ? 'var(--danger)'
    : risk.score >= 55 ? 'var(--warning)'
    : 'var(--accent)'
    : 'var(--accent)';

  const criticalFiles = files.filter(f => f.risk_score >= 75 || f.violations?.length > 0);
  const recentPrs = prs.slice(0, 5);
  const highRisk = risk && risk.score >= 55;

  const repoPath = meta ? `/${meta.owner}/${meta.name}`.toUpperCase() : '...';

  return (
    <Layout activeNav="overview" repoId={repoId}>
      {/* Top bar */}
      <header style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        padding: '0 2rem',
        height: 52,
        position: 'sticky',
        top: 0,
        zIndex: 10,
        flexShrink: 0,
        fontFamily: 'var(--mono)',
      }}>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>::</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--accent)', letterSpacing: '0.08em', fontWeight: 500 }}>
          ANALYZING TARGET: {repoPath}
        </span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', letterSpacing: '0.04em' }}>//</span>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
          ID: {repoId?.slice(0, 8).toUpperCase() ?? '—'}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.08em', cursor: 'pointer' }}>DOCS</span>
          <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.08em', cursor: 'pointer' }}>SUPPORT</span>
          <span style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>🔔</span>
          <div style={{
            width: 30, height: 30, background: 'var(--surface-raised)',
            border: '1px solid var(--border)', borderRadius: 3,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 600,
            color: 'var(--text-muted)', cursor: 'pointer',
          }}>
            USR
          </div>
        </div>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, padding: '2.5rem 2.5rem 3rem', overflowY: 'auto' }}>

        {/* Hero */}
        <div style={{ marginBottom: '2.5rem' }}>
          <div style={{ lineHeight: 0.88 }}>
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
        </div>

        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {[1,2,3,4].map(i => (
              <div key={i} className="skeleton" style={{ height: 160, borderRadius: 3 }} />
            ))}
          </div>
        ) : (
          <>
            {/* Top metric row */}
            <div className="stagger" style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 1fr 1fr',
              gap: '1rem',
              marginBottom: '1rem',
            }}>
              {/* Global Risk Index */}
              <div style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                padding: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{
                    fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 600,
                    color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase',
                  }}>
                    GLOBAL RISK INDEX
                  </span>
                  <span style={{
                    fontFamily: 'var(--sans)', fontSize: '0.62rem', fontWeight: 700,
                    background: 'var(--accent)', color: '#000',
                    padding: '2px 8px', borderRadius: 2, letterSpacing: '0.08em',
                  }}>
                    LIVE
                  </span>
                </div>
                <div style={{
                  fontFamily: 'var(--heading)',
                  fontSize: 'clamp(3.5rem, 8vw, 5rem)',
                  fontWeight: 700,
                  color: riskAccentColor,
                  letterSpacing: '-0.03em',
                  lineHeight: 1,
                  marginTop: '0.5rem',
                }}>
                  {riskScore}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <div style={{
                    width: 28, height: 4, borderRadius: 2,
                    background: risk && risk.score >= 30 ? riskAccentColor : 'var(--border)',
                  }} />
                  <span style={{
                    fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 600,
                    color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase',
                  }}>
                    {riskLabel}
                  </span>
                </div>
              </div>

              {/* Files Scanned */}
              <div style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                padding: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}>
                <span style={{
                  fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 600,
                  color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase',
                }}>
                  FILES SCANNED
                </span>
                <div style={{
                  fontFamily: 'var(--heading)',
                  fontSize: 'clamp(2rem, 5vw, 3rem)',
                  fontWeight: 700,
                  color: 'var(--text-h)',
                  letterSpacing: '-0.02em',
                  lineHeight: 1,
                }}>
                  {files.length > 0 ? files.length.toLocaleString() : '—'}
                </div>
                {files.length > 0 && (
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: '0.68rem',
                    color: 'var(--accent)', letterSpacing: '0.04em',
                  }}>
                    -&gt; {criticalFiles.length} high-risk file{criticalFiles.length !== 1 ? 's' : ''}
                  </div>
                )}
              </div>

              {/* Critical Vulns */}
              <div style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                padding: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}>
                <span style={{
                  fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 600,
                  color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase',
                }}>
                  CRITICAL VULNS
                </span>
                <div style={{
                  fontFamily: 'var(--heading)',
                  fontSize: 'clamp(2rem, 5vw, 3rem)',
                  fontWeight: 700,
                  color: criticalFiles.length > 0 ? 'var(--accent)' : 'var(--text-h)',
                  letterSpacing: '-0.02em',
                  lineHeight: 1,
                }}>
                  {String(criticalFiles.length).padStart(2, '0')}
                </div>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: '0.68rem',
                  color: 'var(--text-muted)', letterSpacing: '0.04em',
                }}>
                  // {criticalFiles.length > 0 ? 'Awaiting resolution' : 'All clear'}
                </div>
              </div>
            </div>

            {/* Active Mitigation banner — only when high risk */}
            {highRisk && (
              <div style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                padding: '1.25rem 1.5rem',
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
              }}>
                <div>
                  <div style={{
                    fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700,
                    color: 'var(--accent)', letterSpacing: '0.12em', textTransform: 'uppercase',
                    marginBottom: '0.5rem',
                  }}>
                    ACTIVE MITIGATION
                  </div>
                  <div style={{
                    fontFamily: 'var(--sans)', fontSize: '1rem', fontWeight: 500,
                    color: 'var(--text-h)', lineHeight: 1.4,
                  }}>
                    {risk && risk.score >= 75
                      ? 'Critical risk detected. Immediate review of high-risk files required.'
                      : 'Elevated risk level. Review flagged files and recent PR changes.'}
                  </div>
                </div>
                <button
                  onClick={() => navigate(`/repo/${repoId}/files`)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--accent)',
                    color: 'var(--accent)',
                    fontFamily: 'var(--sans)', fontSize: '0.72rem', fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '0.08em',
                    padding: '0.6rem 1rem', borderRadius: 3,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-bg)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                >
                  VIEW FILES
                </button>
              </div>
            )}

            {/* Recent Scans */}
            <div style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 3,
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '1rem 1.5rem',
                borderBottom: '1px solid var(--border)',
              }}>
                <span style={{
                  fontFamily: 'var(--heading)', fontSize: '0.85rem', fontWeight: 700,
                  color: 'var(--text-h)', letterSpacing: '0.06em', textTransform: 'uppercase',
                }}>
                  RECENT SCANS
                </span>
                <button
                  onClick={() => navigate(`/repo/${repoId}/prs`)}
                  style={{
                    background: 'transparent', border: 'none',
                    fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 600,
                    color: 'var(--text-muted)', letterSpacing: '0.08em',
                    textTransform: 'uppercase', cursor: 'pointer',
                    transition: 'color 0.1s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                >
                  VIEW ALL -&gt;
                </button>
              </div>

              {recentPrs.length === 0 ? (
                <div style={{
                  padding: '2.5rem', textAlign: 'center',
                  fontFamily: 'var(--mono)', fontSize: '0.72rem',
                  color: 'var(--text-muted)', letterSpacing: '0.08em',
                }}>
                  NO_SCAN_HISTORY //
                </div>
              ) : (
                <div>
                  {recentPrs.map((pr, i) => {
                    const status = prStatus(pr);
                    return (
                      <div
                        key={pr.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '100px 1.2fr 1.5fr 80px 70px',
                          alignItems: 'center',
                          gap: '1rem',
                          padding: '0.9rem 1.5rem',
                          borderBottom: i < recentPrs.length - 1 ? '1px solid var(--border)' : 'none',
                          transition: 'background 0.1s',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-raised)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                      >
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: '0.7rem',
                          color: 'var(--text-muted)', letterSpacing: '0.04em',
                        }}>
                          {prHexId(pr)}
                        </span>
                        <span style={{
                          fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 600,
                          color: 'var(--text-h)', letterSpacing: '0.04em', textTransform: 'uppercase',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {pr.title}
                        </span>
                        <span style={{
                          fontFamily: 'var(--sans)', fontSize: '0.72rem',
                          color: 'var(--text-muted)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          #{pr.number} by {pr.author_login}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <div style={{
                            width: 8, height: 8, borderRadius: 1,
                            background: status.color, flexShrink: 0,
                          }} />
                          <span style={{
                            fontFamily: 'var(--sans)', fontSize: '0.7rem', fontWeight: 700,
                            color: status.color, letterSpacing: '0.08em',
                          }}>
                            {status.label}
                          </span>
                        </div>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: '0.68rem',
                          color: 'var(--text-muted)', textAlign: 'right',
                        }}>
                          {timeAgo(pr.created_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </Layout>
  );
};

export default Overview;
