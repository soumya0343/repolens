import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../lib/apiConfig';
import Layout from '../components/Layout';
import { toast } from 'sonner';

interface ConnectedRepo {
  id: string;
  name: string;
  owner: string;
  synced_at?: string;
  stats?: {
    commits: number;
    pull_requests: number;
  };
}

interface LogEntry {
  level: 'INFO' | 'WARN' | 'ERROR';
  time: string;
  message: string;
}

function repoHealth(synced_at?: string): 'HEALTHY' | 'STALE' | 'OFFLINE' {
  if (!synced_at) return 'OFFLINE';
  const hours = (Date.now() - new Date(synced_at).getTime()) / 3_600_000;
  if (hours < 48) return 'HEALTHY';
  if (hours < 168) return 'STALE';
  return 'OFFLINE';
}

function formatStat(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function buildLogs(repos: ConnectedRepo[]): LogEntry[] {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 19) + 'Z';
  const logs: LogEntry[] = [
    { level: 'INFO', time: fmt(new Date(now.getTime() - 120_000)), message: 'System check initiated.' },
  ];
  if (repos.length > 0) {
    logs.push({
      level: 'INFO',
      time: fmt(new Date(now.getTime() - 60_000)),
      message: `Synced ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} successfully.`,
    });
  }
  const offline = repos.find(r => repoHealth(r.synced_at) === 'OFFLINE');
  if (offline) {
    logs.push({
      level: 'WARN',
      time: fmt(new Date(now.getTime() - 30_000)),
      message: `${offline.name} unreachable. Retrying...`,
    });
  }
  logs.push({ level: 'INFO', time: fmt(now), message: 'Awaiting next command.' });
  return logs;
}

const healthStyle: Record<string, React.CSSProperties> = {
  HEALTHY: { background: 'var(--accent)', color: '#000', border: 'none' },
  STALE:   { background: 'transparent', color: 'var(--warning)', border: '1px solid var(--warning)' },
  OFFLINE: { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' },
};

const Home: React.FC = () => {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<ConnectedRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { navigate('/'); return; }
    axios
      .get(`${API_BASE_URL}/repos/`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => setRepos(res.data))
      .catch(() => toast.error("Failed to load repos. Check your connection."))
      .finally(() => setLoading(false));
  }, [navigate]);

  const filtered = repos.filter(r =>
    `${r.owner}/${r.name}`.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const logs = buildLogs(repos);

  return (
    <Layout activeNav="home">
      {/* Top bar */}
      <header style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: '1.5rem',
        padding: '0 2rem',
        height: 52,
        position: 'sticky',
        top: 0,
        zIndex: 10,
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--heading)',
          fontSize: '0.85rem',
          fontWeight: 700,
          color: 'var(--accent)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}>
          REPO_LENS
        </span>

        <input
          type="text"
          placeholder="QUERY_REPOS..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            maxWidth: 320,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            color: 'var(--text)',
            fontFamily: 'var(--mono)',
            fontSize: '0.72rem',
            letterSpacing: '0.06em',
            padding: '0.4rem 0.75rem',
            outline: 'none',
            flex: '0 0 auto',
            width: 240,
          }}
          onFocus={e => (e.target.style.borderColor = 'var(--accent-border)')}
          onBlur={e => (e.target.style.borderColor = 'var(--border)')}
        />

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 500, cursor: 'pointer' }}>DOCS</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 500, cursor: 'pointer' }}>SUPPORT</span>
          <span style={{ color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.9rem' }}>🔔</span>
          <div style={{
            width: 30, height: 30,
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 600,
            color: 'var(--text-muted)', cursor: 'pointer', letterSpacing: '0.04em',
          }}>
            USR
          </div>
        </div>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, padding: '2.5rem 2.5rem 3rem', overflowY: 'auto' }}>

        {/* Hero */}
        <div style={{ marginBottom: '2.5rem' }}>
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.7rem',
            color: 'var(--accent)',
            letterSpacing: '0.12em',
            marginBottom: '0.6rem',
          }}>
            // OVERVIEW_
          </div>
          <div style={{ lineHeight: 0.9 }}>
            <div style={{
              fontFamily: 'var(--heading)',
              fontSize: 'clamp(2.8rem, 6vw, 5rem)',
              fontWeight: 700,
              color: 'var(--text-h)',
              textTransform: 'uppercase',
              letterSpacing: '-0.02em',
            }}>
              CONNECTED
            </div>
            <div style={{
              fontFamily: 'var(--heading)',
              fontSize: 'clamp(2.8rem, 6vw, 5rem)',
              fontWeight: 700,
              color: 'var(--border-bright)',
              textTransform: 'uppercase',
              letterSpacing: '-0.02em',
            }}>
              REPOSITORIES
            </div>
          </div>
        </div>

        {/* Repo cards */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '1rem' }}>
            {[1, 2, 3].map(i => (
              <div key={i} className="skeleton" style={{ height: 190, borderRadius: 3 }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '4rem 2rem',
            color: 'var(--text-muted)', fontFamily: 'var(--mono)',
            fontSize: '0.78rem', letterSpacing: '0.08em',
          }}>
            {repos.length === 0 ? (
              <>
                <div style={{ marginBottom: '1.25rem' }}>NO_REPOS_CONNECTED //</div>
                <button
                  onClick={() => navigate('/setup')}
                  style={{
                    background: 'var(--accent)', color: '#000',
                    border: 'none', borderRadius: 3,
                    fontFamily: 'var(--sans)', fontSize: '0.78rem',
                    fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.06em', padding: '0.65rem 1.5rem',
                    cursor: 'pointer',
                  }}
                >
                  [+] CONNECT FIRST REPO
                </button>
              </>
            ) : 'NO_MATCH_FOUND //'}
          </div>
        ) : (
          <div
            className="stagger"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '1rem' }}
          >
            {filtered.map((repo, i) => {
              const health = repoHealth(repo.synced_at);
              const shortId = `REPO-${String.fromCharCode(65 + (i % 26))}${String(i + 1).padStart(2, '0')}`;
              return (
                <div
                  key={repo.id}
                  onClick={() => { toast.info(`Opening ${repo.owner}/${repo.name}…`); navigate(`/repo/${repo.id}`); }}
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    padding: '1.25rem',
                    cursor: 'pointer',
                    transition: 'border-color 0.15s',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1rem',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent-border)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                >
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: '0.62rem',
                      color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase',
                    }}>
                      ID: {shortId}
                    </span>
                    <span style={{
                      fontFamily: 'var(--sans)', fontSize: '0.62rem', fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      padding: '2px 8px', borderRadius: 2,
                      ...healthStyle[health],
                    }}>
                      {health}
                    </span>
                  </div>

                  {/* Name */}
                  <div>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: '0.68rem',
                      color: 'var(--text-muted)', letterSpacing: '0.04em', marginBottom: 3,
                    }}>
                      {repo.owner}/
                    </div>
                    <div style={{
                      fontFamily: 'var(--heading)', fontSize: '1.5rem',
                      fontWeight: 700, color: 'var(--text-h)',
                      textTransform: 'uppercase', letterSpacing: '-0.01em', lineHeight: 1.1,
                      wordBreak: 'break-word',
                    }}>
                      {repo.name}
                    </div>
                  </div>

                  {/* Stats */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                    gap: '0.5rem', paddingTop: '0.75rem',
                    borderTop: '1px solid var(--border)',
                  }}>
                    {[
                      { label: 'COMMITS',  value: formatStat(repo.stats?.commits) },
                      { label: 'OPEN PRS', value: formatStat(repo.stats?.pull_requests) },
                      { label: 'COVERAGE', value: health === 'HEALTHY' ? 'LIVE' : '—' },
                    ].map(stat => (
                      <div key={stat.label}>
                        <div style={{
                          fontFamily: 'var(--sans)', fontSize: '0.6rem', fontWeight: 500,
                          color: 'var(--text-muted)', letterSpacing: '0.08em',
                          textTransform: 'uppercase', marginBottom: '0.25rem',
                        }}>
                          {stat.label}
                        </div>
                        <div style={{
                          fontFamily: 'var(--heading)', fontSize: '1.05rem', fontWeight: 700,
                          color: stat.label === 'COVERAGE' && health === 'HEALTHY'
                            ? 'var(--accent)' : 'var(--text-h)',
                          letterSpacing: '-0.01em',
                        }}>
                          {stat.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* System logs */}
        {!loading && (
          <div style={{
            marginTop: '2.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            padding: '1.25rem 1.5rem',
          }}>
            <div style={{
              fontFamily: 'var(--sans)', fontSize: '0.72rem', fontWeight: 600,
              color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase',
              marginBottom: '0.875rem',
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>SYSTEM_LOGS //</span>
              <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>_</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {logs.map((log, i) => (
                <div key={i} style={{
                  fontFamily: 'var(--mono)', fontSize: '0.72rem',
                  display: 'flex', gap: '0.75rem', lineHeight: 1.6,
                }}>
                  <span style={{
                    color: log.level === 'WARN' ? 'var(--warning)' : log.level === 'ERROR' ? 'var(--danger)' : 'var(--accent)',
                    minWidth: 52,
                  }}>
                    [{log.level}]
                  </span>
                  <span style={{ color: 'var(--text-muted)', minWidth: 180 }}>{log.time}</span>
                  <span style={{ color: 'var(--text)' }}>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </Layout>
  );
};

export default Home;
