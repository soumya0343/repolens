import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../lib/apiConfig';
import Layout from '../components/Layout';
import Tooltip from '../components/Tooltip';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────

interface FileData {
  path: string;
  language: string;
  lines: number;
  risk_score: number;
  changes?: number;
  violations: string[];
}

interface RepoMeta { id: string; name: string; owner: string; synced_at?: string }

interface FileDetail {
  path: string;
  churn_history: { week: string; additions: number; deletions: number }[];
  ownership: { contributor: string; commits: number; share: number }[];
  coupling_rules: { file: string; score: number }[];
  violations: { type: string; severity: string; description: string; line: number }[];
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

function riskScoreColor(s: number): string {
  if (s >= 75) return 'var(--danger)';
  if (s >= 55) return 'var(--warning)';
  if (s >= 30) return '#ccaa00';
  return 'var(--accent)';
}

function churnLabel(f: FileData): string {
  const changes = f.changes ?? 0;
  if (f.risk_score >= 75 || changes > 50) return 'High';
  if (f.risk_score >= 40 || changes > 20) return 'Medium';
  return 'Low';
}

function churnColor(label: string): string {
  if (label === 'High')   return 'var(--danger)';
  if (label === 'Medium') return 'var(--warning)';
  return 'var(--text-muted)';
}

function buildTerminalLogs(files: FileData[], meta: RepoMeta | null): { type: 'ok' | 'info' | 'warn' | 'crit'; text: string }[] {
  const logs: { type: 'ok' | 'info' | 'warn' | 'crit'; text: string }[] = [
    { type: 'ok',   text: '> System initialized. Ready for file analysis.' },
    { type: 'info', text: `[INFO] Loading risk metrics for ${files.length.toLocaleString()} files...` },
  ];

  const highChurn = files.filter(f => (f.changes ?? 0) > 50 || f.risk_score >= 75);
  if (highChurn.length > 0) {
    const dir = highChurn[0].path.split('/').slice(0, 2).join('/');
    logs.push({ type: 'warn', text: `[WARN] High churn detected in ${dir} directory.` });
  }

  const critical = files.filter(f => f.violations?.length > 0);
  if (critical.length > 0) {
    logs.push({ type: 'crit', text: `[CRIT] ${critical.length} violation${critical.length > 1 ? 's' : ''} found — review ${critical[0].path} immediately.` });
  } else if (files.length > 0) {
    logs.push({ type: 'info', text: `[INFO] No critical violations found across ${files.length} files.` });
  }

  if (meta) {
    logs.push({ type: 'info', text: `[INFO] Repository: ${meta.owner}/${meta.name} — analysis complete.` });
  }

  return logs;
}

type SortKey = 'risk_score' | 'path' | 'changes';
type SortDir = 'asc' | 'desc';

// ── Component ─────────────────────────────────────────────────────────────

const Files: React.FC = () => {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate   = useNavigate();

  const [meta,    setMeta]    = useState<RepoMeta | null>(null);
  const [files,   setFiles]   = useState<FileData[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState('');
  const [sortKey,       setSortKey]       = useState<SortKey>('risk_score');
  const [sortDir,       setSortDir]       = useState<SortDir>('desc');
  const [filterRisk,    setFilterRisk]    = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>('all');
  const [selectedFile,  setSelectedFile]  = useState<FileData | null>(null);
  const [fileDetail,    setFileDetail]    = useState<FileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem('token')) { navigate('/'); return; }
    if (!repoId) { toast.warning('No repo selected.'); navigate('/home'); return; }
    Promise.all([
      apiFetch<RepoMeta>(`${API_BASE_URL}/repos/${repoId}`),
      apiFetch<FileData[]>(`${API_BASE_URL}/repos/${repoId}/files`),
    ]).then(([m, f]) => {
      if (m) setMeta(m);
      if (f) setFiles(f);
      else toast.error('Failed to load files.');
    }).finally(() => setLoading(false));
  }, [repoId, navigate]);

  const openFileDetail = async (file: FileData) => {
    setSelectedFile(file);
    setFileDetail(null);
    setDetailLoading(true);
    const detail = await apiFetch<FileDetail>(
      `${API_BASE_URL}/repos/${repoId}/files/detail?path=${encodeURIComponent(file.path)}`
    );
    setFileDetail(detail);
    setDetailLoading(false);
  };

  const closeDetail = () => { setSelectedFile(null); setFileDetail(null); };

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const filtered = useMemo(() => {
    let out = files.filter(f => f.path.toLowerCase().includes(search.toLowerCase()));
    if (filterRisk !== 'all') {
      out = out.filter(f => {
        if (filterRisk === 'critical') return f.risk_score >= 75;
        if (filterRisk === 'high')     return f.risk_score >= 55 && f.risk_score < 75;
        if (filterRisk === 'medium')   return f.risk_score >= 30 && f.risk_score < 55;
        return f.risk_score < 30;
      });
    }
    return [...out].sort((a, b) => {
      let diff = 0;
      if (sortKey === 'risk_score') diff = a.risk_score - b.risk_score;
      else if (sortKey === 'path')    diff = a.path.localeCompare(b.path);
      else if (sortKey === 'changes') diff = (a.changes ?? 0) - (b.changes ?? 0);
      return sortDir === 'desc' ? -diff : diff;
    });
  }, [files, search, sortKey, sortDir, filterRisk]);

  const criticalCount = files.filter(f => f.risk_score >= 75).length;
  const logs = buildTerminalLogs(files, meta);
  const repoName = meta ? `${meta.owner.toUpperCase()}-CORE` : 'REPO_CORE';

  return (
    <Layout activeNav="files" repoId={repoId}>
      {/* ── Top bar ─────────────────────────────────────── */}
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '0 2rem', height: 52,
        position: 'sticky', top: 0, zIndex: 10, flexShrink: 0,
      }}>
        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.04em' }}>
          <span style={{ cursor: 'pointer', transition: 'color 0.1s' }}
            onMouseEnter={e => { (e.target as HTMLSpanElement).style.color = 'var(--text)'; }}
            onMouseLeave={e => { (e.target as HTMLSpanElement).style.color = 'var(--text-muted)'; }}
          >{repoName}</span>
          <span style={{ color: 'var(--border-bright)' }}>/</span>
          <span>FILES</span>
        </div>

        {/* Search */}
        <div style={{ position: 'relative', marginLeft: '1rem' }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.8rem' }}>🔍</span>
          <input
            type="text"
            placeholder="/SEARCH_FILES..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3,
              color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.72rem',
              letterSpacing: '0.04em', padding: '0.38rem 0.75rem 0.38rem 2rem',
              outline: 'none', width: 220,
            }}
            onFocus={e => (e.target.style.borderColor = 'var(--accent-border)')}
            onBlur={e => (e.target.style.borderColor = 'var(--border)')}
          />
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.08em', cursor: 'pointer' }}>DOCS</span>
          <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.08em', cursor: 'pointer' }}>SUPPORT</span>
          <span style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>🔔</span>
          <div style={{ width: 30, height: 30, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
            USR
          </div>
        </div>
      </header>

      {/* ── Main ────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: '2rem 2.5rem 3rem', overflowY: 'auto' }}>

        {/* Hero */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{
            fontFamily: 'var(--heading)',
            fontSize: 'clamp(3rem, 7vw, 5rem)',
            fontWeight: 700,
            color: 'var(--text-h)',
            textTransform: 'uppercase',
            letterSpacing: '-0.02em',
            lineHeight: 0.9,
          }}>
            FILE_SYSTEM
          </div>
          <div style={{ fontFamily: 'var(--sans)', fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.75rem', maxWidth: 560, lineHeight: 1.5 }}>
            Every file tracked by commit history, ranked by risk. Risk combines how often a file changes, who owns it, known rule violations, and whether secrets were found inside it.
          </div>
        </div>

        {/* Stats + actions row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            {[
              { label: `TOTAL_FILES: ${loading ? '...' : files.length.toLocaleString()}`, active: true },
              { label: `CRITICAL_RISK: ${loading ? '...' : criticalCount}`, active: true },
              { label: 'BRANCH: main', active: true },
            ].map(tag => (
              <span key={tag.label} style={{
                fontFamily: 'var(--mono)', fontSize: '0.7rem', fontWeight: 500,
                color: 'var(--accent)', background: 'var(--accent-bg)',
                border: '1px solid var(--accent-border)',
                padding: '3px 10px', borderRadius: 2, letterSpacing: '0.04em',
              }}>
                {tag.label}
              </span>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            {/* Filter dropdown */}
            <select
              value={filterRisk}
              onChange={e => setFilterRisk(e.target.value as typeof filterRisk)}
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3,
                color: 'var(--text)', fontFamily: 'var(--sans)', fontSize: '0.72rem',
                fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
                padding: '0.45rem 0.85rem', cursor: 'pointer', outline: 'none',
              }}
            >
              <option value="all">ALL RISK</option>
              <option value="critical">CRITICAL</option>
              <option value="high">HIGH</option>
              <option value="medium">MEDIUM</option>
              <option value="low">LOW</option>
            </select>
            <button style={{
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 3,
              color: 'var(--text)', fontFamily: 'var(--sans)', fontSize: '0.72rem',
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              padding: '0.45rem 0.9rem', cursor: 'pointer', transition: 'border-color 0.15s',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
              onClick={() => handleSort(sortKey)}
            >
              FILTER_VIEW
            </button>
            <button style={{
              background: 'var(--accent)', border: 'none', borderRadius: 3,
              color: '#000', fontFamily: 'var(--sans)', fontSize: '0.72rem',
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              padding: '0.45rem 0.9rem', cursor: 'pointer', transition: 'opacity 0.15s',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.85'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
            >
              RUN_ANALYSIS
            </button>
          </div>
        </div>

        {/* Files table */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, marginBottom: '1.5rem' }}>
          {/* Table header */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 120px 120px 130px 80px',
            padding: '0.7rem 1.5rem',
            borderBottom: '1px solid var(--border)',
            gap: '1rem',
          }}>
            {([
              { label: 'FILE_PATH', key: 'path' },
              { label: 'RISK_SCORE', key: 'risk_score', tip: 'A 0–100 score combining how often this file changes, how concentrated its ownership is, architectural violations, and any secrets found.' },
              { label: 'CHURN_RATE', key: 'changes', tip: 'How many times this file has been modified in commits. High churn = frequently changing code, which increases the chance of introducing bugs.' },
              { label: 'LAST_MODIFIED', key: null },
              { label: 'ACTIONS', key: null },
            ] as { label: string; key: SortKey | null; tip?: string }[]).map(col => (
              <span
                key={col.label}
                onClick={() => col.key && handleSort(col.key)}
                style={{
                  fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700,
                  color: sortKey === col.key ? 'var(--accent)' : 'var(--text-muted)',
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  cursor: col.key ? 'pointer' : 'default',
                  userSelect: 'none',
                  display: 'flex', alignItems: 'center', gap: '0.3rem',
                }}
              >
                {col.label}
                {col.key === sortKey && (
                  <span style={{ fontSize: '0.6rem' }}>{sortDir === 'desc' ? '↓' : '↑'}</span>
                )}
                {col.tip && <Tooltip text={col.tip} position="bottom" />}
              </span>
            ))}
          </div>

          {/* Rows */}
          {loading ? (
            <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 44, borderRadius: 2 }} />)}
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
              NO_FILES_FOUND //
            </div>
          ) : (
            filtered.map((file, i) => {
              const isHighRisk = file.risk_score >= 75;
              const churn = churnLabel(file);
              const scoreColor = riskScoreColor(file.risk_score);
              return (
                <div
                  key={file.path}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 120px 120px 130px 80px',
                    padding: '0.85rem 1.5rem', gap: '1rem', alignItems: 'center',
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                    transition: 'background 0.1s', cursor: 'pointer',
                    background: selectedFile?.path === file.path ? 'var(--surface-raised)' : 'transparent',
                  }}
                  onClick={() => openFileDetail(file)}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-raised)'; }}
                  onMouseLeave={e => {
                    if (selectedFile?.path !== file.path)
                      (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  }}
                >
                  {/* File path */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
                    <span style={{ fontSize: '0.85rem', flexShrink: 0, color: isHighRisk ? 'var(--warning)' : 'var(--text-muted)' }}>
                      {isHighRisk ? '⚠' : '▪'}
                    </span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: '0.78rem', color: 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {file.path}
                    </span>
                    {file.violations?.length > 0 && (
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: '0.58rem', fontWeight: 600,
                        background: 'rgba(255,65,65,0.12)', color: 'var(--danger)',
                        border: '1px solid rgba(255,65,65,0.25)',
                        padding: '1px 5px', borderRadius: 2, flexShrink: 0,
                      }}>
                        {file.violations.length} violations
                      </span>
                    )}
                  </div>

                  {/* Risk score */}
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: '0.82rem', fontWeight: 600,
                    color: scoreColor, letterSpacing: '0.02em',
                  }}>
                    {file.risk_score.toFixed(1)}%
                  </span>

                  {/* Churn rate */}
                  <span style={{
                    fontFamily: 'var(--sans)', fontSize: '0.78rem', fontWeight: 500,
                    color: churnColor(churn),
                  }}>
                    {churn}
                  </span>

                  {/* Last modified — not in API, show language+lines as proxy */}
                  <span style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {file.language ? `${file.language} · ${file.lines}L` : '—'}
                  </span>

                  {/* Actions */}
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: '0.9rem', color: 'var(--text-muted)',
                    letterSpacing: '0.1em', cursor: 'pointer',
                    transition: 'color 0.1s',
                  }}
                    onMouseEnter={e => { (e.target as HTMLSpanElement).style.color = 'var(--accent)'; }}
                    onMouseLeave={e => { (e.target as HTMLSpanElement).style.color = 'var(--text-muted)'; }}
                  >
                    •••
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Terminal output */}
        <div style={{
          background: 'var(--code-bg)', border: '1px solid var(--border)', borderRadius: 3,
          padding: '1.25rem 1.5rem',
          fontFamily: 'var(--mono)', fontSize: '0.72rem', lineHeight: 1.8,
        }}>
          {logs.map((log, i) => (
            <div key={i} style={{
              color: log.type === 'ok'   ? 'var(--accent)'
                   : log.type === 'warn' ? 'var(--warning)'
                   : log.type === 'crit' ? 'var(--danger)'
                   : 'var(--text-muted)',
            }}>
              {log.text}
            </div>
          ))}
          <div style={{ color: 'var(--accent)', marginTop: '0.25rem' }}>_</div>
        </div>

      </main>

      {/* ── File Detail Panel ───────────────────────────────────────────── */}
      {selectedFile && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeDetail}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 40 }}
          />
          {/* Panel */}
          <div style={{
            position: 'fixed', right: 0, top: 0, bottom: 0, width: 420,
            background: 'var(--surface)', borderLeft: '1px solid var(--border)',
            zIndex: 50, display: 'flex', flexDirection: 'column',
            overflowY: 'auto',
          }}>
            {/* Panel header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '1rem 1.25rem',
              borderBottom: '1px solid var(--border)',
              position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1,
            }}>
              <div>
                <div style={{ fontFamily: 'var(--sans)', fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
                  FILE DETAIL
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', color: 'var(--text)', wordBreak: 'break-all' }}>
                  {selectedFile.path}
                </div>
              </div>
              <button
                onClick={closeDetail}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer', padding: '0.25rem 0.5rem', lineHeight: 1, flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
              >
                ×
              </button>
            </div>

            {/* Panel body */}
            <div style={{ flex: 1, padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {/* File meta */}
              <div style={{ display: 'flex', gap: '1rem' }}>
                <div style={{ flex: 1, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem' }}>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>RISK</div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '1.4rem', fontWeight: 700, color: riskScoreColor(selectedFile.risk_score) }}>
                    {selectedFile.risk_score.toFixed(1)}%
                  </div>
                </div>
                <div style={{ flex: 1, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem' }}>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>LANGUAGE</div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '1rem', fontWeight: 700, color: 'var(--text-h)', textTransform: 'uppercase' }}>
                    {selectedFile.language || '—'}
                  </div>
                </div>
                <div style={{ flex: 1, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem' }}>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>LINES</div>
                  <div style={{ fontFamily: 'var(--heading)', fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-h)' }}>
                    {selectedFile.lines?.toLocaleString() ?? '—'}
                  </div>
                </div>
              </div>

              {detailLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {[1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 3 }} />)}
                </div>
              ) : fileDetail ? (
                <>
                  {/* Churn History */}
                  {fileDetail.churn_history.length > 0 && (() => {
                    const W = 360, H = 80, pad = 8;
                    const data = fileDetail.churn_history;
                    const maxVal = Math.max(...data.map(d => d.additions + d.deletions), 1);
                    const addPts = data.map((d, i) => {
                      const x = pad + (i / Math.max(data.length - 1, 1)) * (W - pad * 2);
                      const y = H - pad - (d.additions / maxVal) * (H - pad * 2);
                      return `${x},${y}`;
                    }).join(' ');
                    const delPts = data.map((d, i) => {
                      const x = pad + (i / Math.max(data.length - 1, 1)) * (W - pad * 2);
                      const y = H - pad - (d.deletions / maxVal) * (H - pad * 2);
                      return `${x},${y}`;
                    }).join(' ');
                    return (
                      <div>
                        <div style={{ fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
                          CHURN HISTORY <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>// 90 days</span>
                        </div>
                        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'var(--code-bg)', borderRadius: 3, display: 'block' }}>
                          <polyline points={addPts} fill="none" stroke="var(--accent)"  strokeWidth="1.5" strokeLinejoin="round" />
                          <polyline points={delPts} fill="none" stroke="var(--danger)"  strokeWidth="1.5" strokeLinejoin="round" strokeDasharray="4 2" />
                        </svg>
                        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.4rem' }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', color: 'var(--accent)' }}>— additions</span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', color: 'var(--danger)' }}>- - deletions</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Ownership */}
                  {fileDetail.ownership.length > 0 && (
                    <div>
                      <div style={{ fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
                        OWNERSHIP
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        {fileDetail.ownership.slice(0, 6).map(o => (
                          <div key={o.contributor} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text)', minWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {o.contributor}
                            </span>
                            <div style={{ flex: 1, height: 6, background: 'var(--surface-raised)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 2, width: `${Math.round(o.share * 100)}%`, opacity: 0.7 }} />
                            </div>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)', minWidth: 36, textAlign: 'right' }}>
                              {Math.round(o.share * 100)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Coupling */}
                  {fileDetail.coupling_rules.length > 0 && (
                    <div>
                      <div style={{ fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
                        CHANGES TOGETHER <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({fileDetail.coupling_rules.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        {fileDetail.coupling_rules.slice(0, 8).map((r, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-raised)', padding: '0.45rem 0.75rem', borderRadius: 2, gap: '0.5rem' }}>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.file}
                            </span>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--warning)', flexShrink: 0 }}>
                              {(r.score * 100).toFixed(0)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Violations */}
                  {fileDetail.violations.length > 0 && (
                    <div>
                      <div style={{ fontFamily: 'var(--sans)', fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-h)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
                        VIOLATIONS <span style={{ color: 'var(--danger)', fontWeight: 400 }}>({fileDetail.violations.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {fileDetail.violations.map((v, i) => (
                          <div key={i} style={{ background: 'rgba(255,65,65,0.06)', border: '1px solid rgba(255,65,65,0.2)', borderRadius: 3, padding: '0.75rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                              <span style={{ fontFamily: 'var(--sans)', fontSize: '0.7rem', fontWeight: 700, color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                {v.type}
                              </span>
                              <span style={{
                                fontFamily: 'var(--sans)', fontSize: '0.6rem', fontWeight: 700,
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                padding: '1px 6px', borderRadius: 2,
                                background: v.severity === 'critical' ? 'rgba(255,65,65,0.2)' : 'rgba(255,150,0,0.15)',
                                color: v.severity === 'critical' ? 'var(--danger)' : 'var(--warning)',
                              }}>
                                {v.severity}
                              </span>
                            </div>
                            <div style={{ fontFamily: 'var(--sans)', fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.4 }}>{v.description}</div>
                            {v.line > 0 && (
                              <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>line {v.line}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {!fileDetail.churn_history.length && !fileDetail.ownership.length && !fileDetail.coupling_rules.length && !fileDetail.violations.length && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.06em', textAlign: 'center', padding: '2rem 0' }}>
                      NO_DETAIL_DATA // trigger backfill
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.06em', textAlign: 'center', padding: '2rem 0' }}>
                  FAILED_TO_LOAD //
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Layout>
  );
};

export default Files;
