import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { API_BASE_URL } from '../lib/apiConfig';

export type NavId =
  | 'home' | 'repositories' | 'overview' | 'files' | 'prs'
  | 'coupling' | 'ci' | 'team' | 'settings' | 'ai';

interface LayoutProps {
  activeNav: NavId;
  repoId?: string;
  children: React.ReactNode;
}

const NAV_ITEMS: { id: NavId; label: string; icon: string }[] = [
  { id: 'home',         label: 'HOME',         icon: '⌂' },
  { id: 'repositories', label: 'REPOSITORIES', icon: '▤' },
  { id: 'overview',     label: 'OVERVIEW',     icon: '◉' },
  { id: 'files',        label: 'FILES',        icon: '▦' },
  { id: 'prs',          label: 'PULL REQUESTS',icon: '⟶' },
  { id: 'coupling',     label: 'COUPLING',     icon: '✦' },
  { id: 'ci',           label: 'CI/TESTS',     icon: '▣' },
  { id: 'team',         label: 'TEAM',         icon: '⚇' },
  { id: 'settings',     label: 'SETTINGS',     icon: '⚙' },
  { id: 'ai',           label: 'AI ASSISTANT', icon: '◈' },
];

const Layout: React.FC<LayoutProps> = ({ activeNav, repoId, children }) => {
  const navigate = useNavigate();
  const [repoName, setRepoName] = useState<{ owner: string; name: string } | null>(null);

  useEffect(() => {
    if (!repoId) { setRepoName(null); return; }
    const token = localStorage.getItem('token');
    fetch(`${API_BASE_URL}/repos/${repoId}`, {
      headers: { Authorization: `Bearer ${token ?? ''}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d ? setRepoName({ owner: d.owner, name: d.name }) : null)
      .catch(() => null);
  }, [repoId]);

  const handleNav = (id: NavId) => {
    if (id === 'home') { navigate('/home'); return; }
    if (id === 'repositories') { navigate('/setup'); return; }
    if (repoId) {
      navigate(`/repo/${repoId}/${id}`);
    } else {
      toast.warning('Select a repository first.');
      navigate('/home');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/');
  };

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      overflow: 'hidden',
      background: 'var(--bg)',
      fontFamily: 'var(--sans)',
    }}>
      {/* ── Sidebar ───────────────────────────────── */}
      <aside style={{
        width: 230,
        minWidth: 230,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '1.5rem 0',
        overflowY: 'auto',
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ padding: '0 1.25rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: 4 }}>
            <div style={{
              width: 28, height: 28,
              background: 'var(--accent)',
              borderRadius: 4,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 3,
              padding: 5,
              boxSizing: 'border-box',
              flexShrink: 0,
            }}>
              {[0,1,2,3].map(i => (
                <div key={i} style={{ background: '#000', borderRadius: 1 }} />
              ))}
            </div>
            <div style={{
              fontFamily: 'var(--heading)',
              fontSize: '0.95rem',
              fontWeight: 700,
              color: 'var(--text-h)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              REPO_CORE
            </div>
          </div>
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.6rem',
            color: 'var(--accent)',
            letterSpacing: '0.06em',
            paddingLeft: 34,
          }}>
            v0.1-alpha
          </div>
        </div>

        {/* New scan button */}
        <div style={{ padding: '0 1rem', marginBottom: '1.25rem' }}>
          <button
            onClick={() => navigate('/setup')}
            style={{
              width: '100%',
              background: 'var(--accent)',
              border: 'none',
              color: '#000',
              fontFamily: 'var(--sans)',
              fontSize: '0.78rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              padding: '0.55rem 0',
              borderRadius: 3,
              cursor: 'pointer',
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.85'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
          >
            [+] NEW_SCAN
          </button>
        </div>

        {/* Active repo chip */}
        {repoName && (
          <div style={{ padding: '0 1rem', marginBottom: '1rem' }}>
            <div
              onClick={() => repoId && navigate(`/repo/${repoId}/overview`)}
              style={{
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent-border)',
                borderRadius: 4,
                padding: '8px 10px',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', flexShrink: 0 }} />
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em' }}>ACTIVE REPO</span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)', paddingLeft: 12, lineHeight: 1.4 }}>
                {repoName.owner}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--accent)', paddingLeft: 12, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {repoName.name}
              </div>
            </div>
          </div>
        )}

        {/* Nav items */}
        <nav style={{ flex: 1, overflowY: 'auto' }}>
          {NAV_ITEMS.map(item => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNav(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  width: '100%',
                  background: isActive ? 'var(--accent)' : 'transparent',
                  border: 'none',
                  color: isActive ? '#000' : 'var(--text-muted)',
                  fontFamily: 'var(--sans)',
                  fontSize: '0.78rem',
                  fontWeight: isActive ? 700 : 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  padding: '0.6rem 1.25rem',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'color 0.1s, background 0.1s',
                }}
                onMouseEnter={e => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
                }}
                onMouseLeave={e => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
                }}
              >
                <span style={{ fontSize: '0.9rem', width: 16, textAlign: 'center', flexShrink: 0 }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Bottom */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', flexShrink: 0 }}>
          {[
            { label: 'DOCS', icon: '▤', action: () => {} },
            { label: 'LOGOUT', icon: '↩', action: handleLogout, danger: true },
          ].map(item => (
            <button
              key={item.label}
              onClick={item.action}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                width: '100%', background: 'transparent', border: 'none',
                color: 'var(--text-muted)',
                fontFamily: 'var(--sans)', fontSize: '0.78rem',
                fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em',
                padding: '0.6rem 1.25rem', cursor: 'pointer', textAlign: 'left',
                transition: 'color 0.1s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.color =
                  item.danger ? 'var(--danger)' : 'var(--text)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
              }}
            >
              <span style={{ fontSize: '0.9rem', width: 16, textAlign: 'center', flexShrink: 0 }}>
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      </aside>

      {/* ── Page content ──────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
};

export default Layout;
